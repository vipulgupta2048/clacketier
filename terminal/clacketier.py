# Clacketier for any terminal on macOS: runs your shell (or any program) in a
# pseudo-terminal and plays a Cherry MX click under every key you type into it.
#
#   clacketier                  your shell, with clicks (asks once to start in every terminal)
#   clacketier -- vim notes.md  one program, with clicks
#   clacketier blue|brown|red   switch keyboards        clacketier volume 30
#   clacketier on|off           start or stop clicks     clacketier setup [--undo]
#
# Python's standard library has the pseudo-terminal; Node needs a native add-on for it.
# Keys and output pass straight through: the clicks are a side effect that can never
# slow or break the terminal. Sounds play through the same long-lived macOS player as
# the Command Code mod (players/macos-key-player.js), and the settings are the mod's.

import errno
import fcntl
import json
import os
import random
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import tty

HERE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
SOUNDS_DIR = os.path.join(HERE, "sounds")
PLAYER_SCRIPT = os.path.join(HERE, "players", "macos-key-player.js")
# The Command Code mod's own store, so both always play the same keyboard.
STORE_FILE = os.path.expanduser("~/.commandcode/mods/.store/clacketier.json")
# Set for everything run inside the wrapper: a nested shell isn't wrapped twice, and
# the Command Code mod stays quiet there (the wrapper already clicks).
WRAPPED_ENV = "CLACKETIER_TERMINAL"
RC_MARK = "# clacketier: mechanical keyboard sounds in every terminal"

KEYBOARDS = {
    "mx-blue": "Cherry MX Blue",
    "mx-brown": "Cherry MX Brown",
    "mx-red": "Cherry MX Red",
}
DEFAULT_PREFS = {"isOn": True, "keyboard": "mx-blue", "volume": 50}
KEY_VARIANTS = [f"key-{index}" for index in range(1, 9)]
ALL_SOUNDS = KEY_VARIANTS + ["space", "enter", "backspace"]
# Longer than this in one read is a paste, not typing: one click, not a burst.
MAX_KEYS_PER_CHUNK = 16
# A held Backspace repeats about 30 times a second: closer than this, a repeat is quiet.
MIN_BACKSPACE_GAP_S = 0.08
# How often a running wrapper looks for settings changed elsewhere.
PREFS_CHECK_S = 0.5
READ_SIZE = 65536

ESC = "\x1b"
PASTE_START = ESC + "[200~"
PASTE_END = ESC + "[201~"
OFF_VALUES = {"0", "off", "false", "no", "mute"}


# Keys ------------------------------------------------------------------------------


def kind_of_character(ch):
    if ch == " ":
        return "space"
    if ch in "\r\n":
        return "enter"
    if ch in "\x7f\b":
        return "backspace"
    if ch < " ":
        return "other"
    return "character"


def escape_length(text):
    """How long the escape sequence at the start of text is (CSI, SS3, or Alt+key)."""
    if text[1:2] == "[":
        for index in range(2, len(text)):
            if "\x40" <= text[index] <= "\x7e":
                return index + 1
        return len(text)
    if text[1:2] == "O":
        return min(3, len(text))
    return min(2, len(text))


def rest_of_paste(text):
    end_at = text.find(PASTE_END)
    if end_at == -1:
        return [], True, text[-(len(PASTE_END) - 1):]
    return classify_chunk(text[end_at + len(PASTE_END):], False, "")


def classify_chunk(chunk, is_in_paste, paste_tail):
    """The key kinds in one read of terminal input: (kinds, is_in_paste, paste_tail). Pure."""
    if is_in_paste:
        return rest_of_paste(paste_tail + chunk)
    kinds = []
    rest = chunk
    while rest:
        esc_at = rest.find(ESC)
        typed = rest if esc_at == -1 else rest[:esc_at]
        kinds += ["paste"] if len(typed) > MAX_KEYS_PER_CHUNK else [kind_of_character(ch) for ch in typed]
        if esc_at == -1:
            break
        rest = rest[esc_at:]
        if rest.startswith(PASTE_START):
            paste_kinds, is_in_paste, paste_tail = rest_of_paste(rest[len(PASTE_START):])
            return kinds + ["paste"] + paste_kinds, is_in_paste, paste_tail
        kinds.append("other")
        rest = rest[escape_length(rest):]
    return kinds, False, ""


def sound_for(kind, random_value):
    """The sound file name for a key kind, or None for keys that stay quiet. Pure."""
    if kind in ("space", "enter", "backspace"):
        return kind
    if kind in ("character", "paste"):
        return KEY_VARIANTS[min(int(random_value * len(KEY_VARIANTS)), len(KEY_VARIANTS) - 1)]
    return None


# Settings --------------------------------------------------------------------------


def find_keyboard(name):
    wanted = name.lower()
    for keyboard_id in KEYBOARDS:
        if wanted in (keyboard_id, keyboard_id.removeprefix("mx-")):
            return keyboard_id
    return None


def parse_prefs(value):
    """Stored prefs, any shape, as valid prefs. Pure."""
    stored = value if isinstance(value, dict) else {}
    is_on = stored.get("isOn")
    keyboard = stored.get("keyboard")
    volume = stored.get("volume")
    is_volume = isinstance(volume, (int, float)) and not isinstance(volume, bool) and volume == volume
    return {
        "isOn": is_on if isinstance(is_on, bool) else DEFAULT_PREFS["isOn"],
        "keyboard": (find_keyboard(keyboard) if isinstance(keyboard, str) else None) or DEFAULT_PREFS["keyboard"],
        "volume": round(min(100, max(0, volume))) if is_volume else DEFAULT_PREFS["volume"],
    }


def read_store():
    try:
        with open(STORE_FILE) as file:
            data = json.load(file)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_store(data):
    os.makedirs(os.path.dirname(STORE_FILE), exist_ok=True)
    partial = f"{STORE_FILE}.{os.getpid()}.tmp"
    with open(partial, "w") as file:
        json.dump(data, file, indent=2)
        file.write("\n")
    os.replace(partial, STORE_FILE)


def describe(prefs):
    if not prefs["isOn"]:
        return "Clacketier: off. `clacketier on` to start."
    return f"Clacketier: {KEYBOARDS[prefs['keyboard']]} · volume {prefs['volume']}%."


def quiet_reason(env):
    setting = env.get("CLACKETIER", "")
    if setting.lower() in OFF_VALUES:
        return "CLACKETIER is off"
    if setting:
        return None
    if env.get("SSH_CONNECTION") or env.get("SSH_TTY"):
        return "over SSH the clicks would play on the remote machine"
    return None


# Player ----------------------------------------------------------------------------


class Player:
    """The long-lived macOS key player, fed one line per key through a queue file."""

    def __init__(self):
        self.queue_dir = None
        self.queue = None
        self.process = None
        self.loaded_keyboard = None

    def is_alive(self):
        return self.process is not None and self.process.poll() is None

    def start(self):
        self.queue_dir = tempfile.mkdtemp(prefix="cmd-key-player-")
        path = os.path.join(self.queue_dir, "queue")
        self.queue = open(path, "a", buffering=1)
        # Its own session: a closed terminal's hangup doesn't end it before it can clean
        # up; it watches our pid and removes the queue folder when we are gone.
        self.process = subprocess.Popen(
            ["/usr/bin/osascript", "-l", "JavaScript", PLAYER_SCRIPT, path, str(os.getpid())],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    def ensure(self, keyboard):
        if not self.is_alive():
            self.stop()
            self.start()
        if self.loaded_keyboard != keyboard:
            self.loaded_keyboard = keyboard
            for sound in ALL_SOUNDS:
                self.write(f"-\t0\t{os.path.join(SOUNDS_DIR, keyboard, sound)}.wav\n")

    def play(self, keyboard, sound, volume):
        level = (min(100, max(0, volume)) / 100) ** 2
        sent_at = int(time.time() * 1000)
        self.write(f"{level:.4f}\t{sent_at}\t{os.path.join(SOUNDS_DIR, keyboard, sound)}.wav\n")

    def write(self, line):
        try:
            self.queue.write(line)
        except (OSError, ValueError, AttributeError):
            self.stop()

    def stop(self):
        if self.queue:
            try:
                self.queue.write("quit\n")
                self.queue.close()
            except (OSError, ValueError):
                pass
        self.queue = None
        self.process = None
        self.loaded_keyboard = None


class Clicker:
    """Turns raw input into clicks, following the stored settings as they change."""

    def __init__(self):
        self.player = Player()
        self.prefs = parse_prefs(read_store().get("prefs"))
        self.prefs_mtime = self.store_mtime()
        self.prefs_checked_at = time.monotonic()
        self.is_in_paste = False
        self.paste_tail = ""
        self.last_backspace_at = None
        self.warm_up()

    def store_mtime(self):
        try:
            return os.stat(STORE_FILE).st_mtime
        except OSError:
            return None

    def is_audible(self):
        return self.prefs["isOn"] and self.prefs["volume"] > 0

    def warm_up(self):
        if self.is_audible():
            self.player.ensure(self.prefs["keyboard"])
            return
        self.player.stop()

    def refresh_prefs(self, now):
        if now - self.prefs_checked_at < PREFS_CHECK_S:
            return
        self.prefs_checked_at = now
        mtime = self.store_mtime()
        if mtime == self.prefs_mtime:
            return
        self.prefs_mtime = mtime
        self.prefs = parse_prefs(read_store().get("prefs"))
        self.warm_up()

    def is_backspace_repeat(self, kind, now):
        if kind != "backspace":
            return False
        is_repeat = self.last_backspace_at is not None and now - self.last_backspace_at < MIN_BACKSPACE_GAP_S
        if not is_repeat:
            self.last_backspace_at = now
        return is_repeat

    def on_input(self, data):
        now = time.monotonic()
        self.refresh_prefs(now)
        kinds, self.is_in_paste, self.paste_tail = classify_chunk(
            data.decode("utf-8", "replace"), self.is_in_paste, self.paste_tail
        )
        if not self.is_audible():
            return
        for kind in kinds:
            sound = sound_for(kind, random.random())
            if sound is None or self.is_backspace_repeat(kind, now):
                continue
            self.player.ensure(self.prefs["keyboard"])
            self.player.play(self.prefs["keyboard"], sound, self.prefs["volume"])


# The wrapper -----------------------------------------------------------------------


def copy_window_size(child_fd):
    try:
        size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(child_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def write_all(fd, data):
    while data:
        try:
            data = data[os.write(fd, data):]
        except InterruptedError:
            continue


def pump(child_fd, clicker):
    """Pass input to the program and its output to the terminal until it ends."""
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    while True:
        try:
            ready, _, _ = select.select([child_fd, stdin_fd], [], [], PREFS_CHECK_S)
        except InterruptedError:
            continue
        # Settings changed elsewhere take effect between keys, so the player is ready
        # before the first key after `clacketier on`.
        clicker.refresh_prefs(time.monotonic())
        if child_fd in ready:
            try:
                output = os.read(child_fd, READ_SIZE)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                return
            if not output:
                return
            write_all(stdout_fd, output)
        if stdin_fd in ready:
            data = os.read(stdin_fd, READ_SIZE)
            if not data:
                # The terminal went away: hang up on the program too.
                os.close(child_fd)
                return
            write_all(child_fd, data)
            # After the key is on its way: a click can never hold up typing.
            try:
                clicker.on_input(data)
            except Exception:
                pass


def exit_code(status):
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


def run_plain(argv):
    """Become the program itself: no clicks, but never a broken terminal."""
    env = {**os.environ, WRAPPED_ENV: "off"}
    os.execvpe(argv[0], argv, env)


def wrap(argv):
    if not sys.stdin.isatty() or not sys.stdout.isatty() or os.environ.get(WRAPPED_ENV) or quiet_reason(os.environ):
        run_plain(argv)
    try:
        clicker = Clicker()
    except Exception:
        run_plain(argv)
    pid, child_fd = os.forkpty()
    if pid == 0:
        os.environ[WRAPPED_ENV] = "1"
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)
    copy_window_size(child_fd)
    signal.signal(signal.SIGWINCH, lambda *_: copy_window_size(child_fd))
    saved = termios.tcgetattr(sys.stdin.fileno())
    try:
        tty.setraw(sys.stdin.fileno())
        pump(child_fd, clicker)
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSAFLUSH, saved)
        clicker.player.stop()
    _, status = os.waitpid(pid, 0)
    return exit_code(status)


# Setup: start in every new terminal ------------------------------------------------


def rc_file():
    shell = os.path.basename(os.environ.get("SHELL", "/bin/zsh"))
    if shell == "bash":
        return os.path.expanduser("~/.bash_profile")
    return os.path.expanduser("~/.zshrc")


def rc_lines():
    test = '[[ $- == *i* && -z "$CLACKETIER_TERMINAL" && -t 0 ]]'
    return f"{RC_MARK}\n{test} && command -v clacketier >/dev/null && exec clacketier\n"


def is_set_up(text):
    return RC_MARK in text


def without_setup(text):
    lines = text.splitlines(keepends=True)
    kept = []
    skip_next = False
    for line in lines:
        if skip_next:
            skip_next = False
            continue
        if line.rstrip("\n") == RC_MARK:
            skip_next = True
            continue
        kept.append(line)
    return "".join(kept)


def read_text(path):
    try:
        with open(path) as file:
            return file.read()
    except OSError:
        return ""


def add_setup():
    path = rc_file()
    text = read_text(path)
    if is_set_up(text):
        return f"Already on: every new terminal starts with clicks ({path})."
    separator = "" if text == "" or text.endswith("\n") else "\n"
    with open(path, "a") as file:
        file.write(f"{separator}\n{rc_lines()}")
    return f"Added to {path}: every new terminal starts with clicks. `clacketier setup --undo` removes it."


def remove_setup():
    path = rc_file()
    text = read_text(path)
    if not is_set_up(text):
        return f"Nothing to undo in {path}."
    with open(path, "w") as file:
        file.write(without_setup(text))
    return f"Removed from {path}. New terminals start without clicks."


def is_on_path():
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        if os.access(os.path.join(folder, "clacketier"), os.X_OK):
            return True
    return False


def first_run_setup():
    """On the first interactive run, offer to start in every new terminal. Asks once."""
    store = read_store()
    if store.get("terminalSetup") or is_set_up(read_text(rc_file())):
        return
    if not is_on_path():
        print("Tip: `npm install -g clacketier`, then run `clacketier` once to hear it in every terminal.")
        return
    answer = input("Start Clacketier in every new terminal? It adds one line to your shell config. [Y/n] ")
    is_yes = answer.strip().lower() in ("", "y", "yes")
    print(add_setup() if is_yes else "OK. `clacketier setup` turns it on any time.")
    write_store({**read_store(), "terminalSetup": "added" if is_yes else "declined"})


# Command line ----------------------------------------------------------------------

USAGE = """\
clacketier                  your shell, with clicks
clacketier -- <program>     one program, with clicks
clacketier status           what's playing
clacketier blue|brown|red   switch keyboard (and turn on)
clacketier on|off           start or stop the clicks
clacketier volume <0-100>   how loud
clacketier setup [--undo]   start (or stop starting) in every new terminal"""


def change_prefs(change):
    store = read_store()
    prefs = {**parse_prefs(store.get("prefs")), **change}
    write_store({**store, "prefs": prefs})
    return describe(prefs)


def command(args):
    """A settings command: (message, exit code), or None when it isn't one."""
    verb = args[0].lower()
    value = args[1] if len(args) > 1 else None
    if verb in ("status",):
        prefs = parse_prefs(read_store().get("prefs"))
        quiet = quiet_reason(os.environ)
        return describe(prefs) + (f"\nQuiet here: {quiet}." if quiet else ""), 0
    if verb in ("help", "-h", "--help"):
        return USAGE, 0
    if verb in ("on", "start", "unmute"):
        return change_prefs({"isOn": True}), 0
    if verb in ("off", "stop", "mute"):
        return change_prefs({"isOn": False}), 0
    if verb in ("volume", "vol"):
        try:
            return change_prefs({"volume": round(min(100, max(0, float(value))))}), 0
        except (TypeError, ValueError):
            return "Use `clacketier volume <0-100>`.", 1
    if verb == "setup":
        return (remove_setup() if value == "--undo" else add_setup()), 0
    keyboard = find_keyboard(verb)
    if keyboard:
        return change_prefs({"isOn": True, "keyboard": keyboard}), 0
    return None


def main(args):
    if sys.platform != "darwin":
        print("Clacketier for the terminal is macOS only.", file=sys.stderr)
        return 1
    if args and args[0] == "--":
        return wrap(args[1:] or [os.environ.get("SHELL", "/bin/zsh")])
    if args:
        result = command(args)
        if result:
            print(result[0])
            return result[1]
        print(f'Unknown "{args[0]}". To run a program with clicks: clacketier -- {args[0]}\n\n{USAGE}', file=sys.stderr)
        return 1
    shell = os.environ.get("SHELL", "/bin/zsh")
    if sys.stdin.isatty() and not os.environ.get(WRAPPED_ENV):
        try:
            first_run_setup()
        except (EOFError, KeyboardInterrupt, OSError):
            print()
    return wrap([shell])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
