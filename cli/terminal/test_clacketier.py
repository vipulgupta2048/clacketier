# Unit tests for Clacketier for the terminal: `python3 -m unittest discover -s terminal`.

import os
import tempfile
import unittest
from unittest import mock

import clacketier as clack


def kinds(chunk):
    return clack.classify_chunk(chunk, False, "")[0]


class Keys(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(kinds("a b"), ["character", "space", "character"])
        self.assertEqual(kinds("\r"), ["enter"])
        self.assertEqual(kinds("\x7f"), ["backspace"])
        self.assertEqual(kinds("\x03"), ["other"])

    def test_escape_sequences_are_one_quiet_key_and_what_follows_clicks(self):
        self.assertEqual(kinds("a\x1b[Ab"), ["character", "other", "character"])
        self.assertEqual(kinds("\x1b[1;5C x"), ["other", "space", "character"])
        self.assertEqual(kinds("\x1bOPa"), ["other", "character"])
        self.assertEqual(kinds("\x1b"), ["other"])

    def test_a_long_read_is_one_paste(self):
        self.assertEqual(kinds("x" * (clack.MAX_KEYS_PER_CHUNK + 1)), ["paste"])
        self.assertEqual(kinds("a\x1b[200~pasted\x1b[201~b"), ["character", "paste", "character"])

    def test_a_paste_end_split_across_reads(self):
        first = clack.classify_chunk("\x1b[200~some text\x1b[2", False, "")
        self.assertEqual(first[:2], (["paste"], True))
        self.assertEqual(clack.classify_chunk("01~ab", True, first[2]), (["character", "character"], False, ""))

    def test_sounds(self):
        self.assertEqual(clack.sound_for("space", 0.5), "space")
        self.assertEqual(clack.sound_for("character", 0.999), "key-8")
        self.assertIsNone(clack.sound_for("other", 0.5))


class Settings(unittest.TestCase):
    def test_prefs_of_any_shape(self):
        self.assertEqual(clack.parse_prefs(None), clack.DEFAULT_PREFS)
        self.assertEqual(clack.parse_prefs({"keyboard": "red", "volume": 250, "isOn": False}),
                         {"isOn": False, "keyboard": "mx-red", "volume": 100})
        self.assertEqual(clack.parse_prefs({"volume": True})["volume"], 50)

    def test_commands_share_the_mods_store(self):
        with tempfile.TemporaryDirectory() as home:
            store = os.path.join(home, "store.json")
            with mock.patch.object(clack, "STORE_FILE", store):
                clack.write_store({"prefs": {"keyboard": "mx-blue"}, "other": 1})
                self.assertEqual(clack.command(["brown"]), ("Clacketier: Cherry MX Brown · volume 50%.", 0))
                self.assertEqual(clack.command(["volume", "x"])[1], 1)
                self.assertEqual(clack.read_store()["other"], 1)
                self.assertIsNone(clack.command(["gateron"]))

    def test_quiet_over_ssh_unless_forced_on(self):
        self.assertIsNotNone(clack.quiet_reason({"SSH_CONNECTION": "1"}))
        self.assertIsNone(clack.quiet_reason({"SSH_CONNECTION": "1", "CLACKETIER": "on"}))
        self.assertIsNotNone(clack.quiet_reason({"CLACKETIER": "off"}))


class Setup(unittest.TestCase):
    def test_add_then_undo_leaves_the_file_as_it_was(self):
        with tempfile.TemporaryDirectory() as home:
            rc = os.path.join(home, ".zshrc")
            with open(rc, "w") as file:
                file.write("export A=1")
            with mock.patch.object(clack, "rc_file", lambda: rc):
                clack.add_setup()
                clack.add_setup()
                text = clack.read_text(rc)
                self.assertEqual(text.count(clack.RC_MARK), 1)
                self.assertIn("exec clacketier", text)
                clack.remove_setup()
                self.assertEqual(clack.read_text(rc).strip(), "export A=1")


if __name__ == "__main__":
    unittest.main()
