// Volume without a player flag: the platform players (afplay, paplay, aplay, Windows
// Media.SoundPlayer) share no volume option, so the mod writes a quieter copy of a
// 16-bit PCM WAV and plays that. Other formats play at their own level.

interface WavLayout {
	readonly dataOffset: number;
	readonly dataBytes: number;
}

// Walk the RIFF chunks for a 16-bit PCM `fmt ` and its `data`. Pure.
export function readPcm16Layout(buffer: Buffer): WavLayout | undefined {
	if (buffer.length < 12) return undefined;
	if (buffer.toString("ascii", 0, 4) !== "RIFF") return undefined;
	if (buffer.toString("ascii", 8, 12) !== "WAVE") return undefined;

	let offset = 12;
	let isPcm16 = false;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= buffer.length) {
			isPcm16 =
				buffer.readUInt16LE(body) === 1 &&
				buffer.readUInt16LE(body + 14) === 16;
		}
		if (id === "data") {
			if (!isPcm16) return undefined;
			const dataBytes = Math.min(size, buffer.length - body);
			return { dataOffset: body, dataBytes: dataBytes - (dataBytes % 2) };
		}
		// Chunks are padded to an even length.
		offset = body + size + (size % 2);
	}
	return undefined;
}

/**
 * A copy of a 16-bit PCM WAV at `volume` percent (0 to 100), or undefined when the
 * buffer is not one. Pure: the input buffer is left as it was.
 */
export function scalePcm16Wav(params: {
	readonly wav: Buffer;
	readonly volume: number;
}): Buffer | undefined {
	const layout = readPcm16Layout(params.wav);
	if (!layout) return undefined;
	// Perceived loudness is roughly logarithmic: a square law makes the low half usable.
	const factor = (Math.min(100, Math.max(0, params.volume)) / 100) ** 2;
	const out = Buffer.from(params.wav);
	const end = layout.dataOffset + layout.dataBytes;
	for (let offset = layout.dataOffset; offset < end; offset += 2) {
		out.writeInt16LE(Math.round(out.readInt16LE(offset) * factor), offset);
	}
	return out;
}
