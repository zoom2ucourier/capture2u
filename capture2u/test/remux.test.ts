import { readFile } from "node:fs/promises";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { PartWriter, remuxToSeekableMp4 } from "../worker/lib/remux";

const fixture = new URL("./fixtures/recording-raw.mp4", import.meta.url);

const boxTypes = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const types: string[] = [];
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		let size = view.getUint32(offset);
		types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
		if (size === 1) size = Number(view.getBigUint64(offset + 8));
		if (size < 8) break;
		offset += size;
	}
	return types;
};

async function remux(raw: Uint8Array, partSize: number, heldParts: number) {
	const parts = new Map<number, Uint8Array>();
	const reads: number[] = [];
	const result = await remuxToSeekableMp4(
		{
			size: raw.length,
			read: async (offset, length) => {
				reads.push(length);
				return raw.subarray(offset, offset + length);
			},
			writePart: async (partNumber, bytes) => {
				if (parts.has(partNumber)) throw new Error("part written twice");
				parts.set(partNumber, bytes.slice());
			},
		},
		{ partSize, heldParts, readWindow: 64 * 1024 },
	);
	const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]);
	const output = new Uint8Array(result.size);
	let offset = 0;
	for (const [, bytes] of ordered) {
		output.set(bytes, offset);
		offset += bytes.length;
	}
	return { result, ordered, output, written: offset };
}

describe("remuxToSeekableMp4", () => {
	it("turns a browser recording into a seekable MP4 with its index first", async () => {
		const raw = new Uint8Array(await readFile(fixture));
		expect(boxTypes(raw)).toContain("moof");

		const { result, ordered, output, written } = await remux(raw, 64 * 1024, 2);
		expect(written).toBe(result.size);
		expect(ordered.map(([partNumber]) => partNumber)).toEqual(
			Array.from({ length: result.partCount }, (_, index) => index + 1),
		);
		for (const [, bytes] of ordered.slice(0, -1))
			expect(bytes.length).toBe(64 * 1024);

		const types = boxTypes(output);
		expect(types).not.toContain("moof");
		expect(types.indexOf("moov")).toBeGreaterThan(-1);
		expect(types.indexOf("moov")).toBeLessThan(types.indexOf("mdat"));

		const input = new Input({
			source: new BufferSource(output),
			formats: ALL_FORMATS,
		});
		const duration = await input.computeDuration();
		const video = await input.getPrimaryVideoTrack();
		const audio = await input.getPrimaryAudioTrack();
		input.dispose();
		expect(duration).toBeGreaterThan(3);
		expect(duration).toBeLessThan(8);
		expect(result.durationSeconds).toBeCloseTo(duration, 0);
		expect(video?.codec).toBe("avc");
		expect(audio?.codec).toBe("aac");
	});

	it("gives the same file whatever the part size", async () => {
		const raw = new Uint8Array(await readFile(fixture));
		const small = await remux(raw, 32 * 1024, 4);
		const single = await remux(raw, 8 * 1024 * 1024, 2);
		expect(single.result.partCount).toBe(1);
		expect(small.output.length).toBe(single.output.length);
		expect(
			small.output.every((byte, index) => byte === single.output[index]),
		).toBe(true);
	});
});

describe("PartWriter", () => {
	it("keeps the first parts back so the index can be filled in last", async () => {
		const sent: number[] = [];
		const writer = new PartWriter(4, 1, async (partNumber) => {
			sent.push(partNumber);
		});
		await writer.write(new Uint8Array(16), 0);
		expect(sent).toEqual([2, 3]);
		await writer.write(new Uint8Array([9, 9]), 1);
		const done = await writer.finish();
		expect(done).toEqual({ size: 16, partCount: 4 });
		expect(sent).toEqual([2, 3, 1, 4]);
	});

	it("refuses to rewrite a part that was already stored", async () => {
		const writer = new PartWriter(4, 0, async () => undefined);
		await writer.write(new Uint8Array(16), 0);
		await expect(writer.write(new Uint8Array([1]), 0)).rejects.toThrow(
			"already stored",
		);
	});
});
