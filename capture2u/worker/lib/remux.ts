import {
	Conversion,
	CustomSource,
	EncodedPacketSink,
	Input,
	type InputTrack,
	MP4,
	Mp4OutputFormat,
	Output,
	StreamTarget,
	type StreamTargetChunk,
} from "mediabunny";

// A browser recording arrives as a fragmented MP4: it plays from the start
// but has no duration and no seek index. This rewrites the container (the
// picture and sound are copied, not re-encoded) into a normal MP4 with its
// index at the front, reading and writing in fixed-size pieces so a long
// recording never has to fit in memory.

export interface RemuxIo {
	size: number;
	read: (offset: number, length: number) => Promise<Uint8Array>;
	writePart: (partNumber: number, bytes: Uint8Array) => Promise<void>;
}

export interface RemuxOptions {
	partSize?: number;
	heldParts?: number;
	readWindow?: number;
}

export interface RemuxResult {
	size: number;
	partCount: number;
	durationSeconds: number | null;
}

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_HELD_PARTS = 2;
const DEFAULT_READ_WINDOW = 8 * 1024 * 1024;
const MAX_CACHED_WINDOWS = 3;
const PACKET_COUNT_MARGIN = 16;

// The index is filled in last but lives at the front, so the first parts stay
// in memory until the end. Every other part is sent once the writer has moved
// a full part past it.
export class PartWriter {
	private readonly buffers = new Map<number, Uint8Array>();
	private readonly sent = new Set<number>();
	private highWater = 0;

	constructor(
		private readonly partSize: number,
		private readonly heldParts: number,
		private readonly send: (
			partNumber: number,
			bytes: Uint8Array,
		) => Promise<void>,
	) {}

	async write(data: Uint8Array, position: number) {
		let offset = 0;
		while (offset < data.length) {
			const absolute = position + offset;
			const index = Math.floor(absolute / this.partSize);
			if (this.sent.has(index))
				throw new Error("The MP4 writer went back to a part already stored");
			let buffer = this.buffers.get(index);
			if (!buffer) {
				buffer = new Uint8Array(this.partSize);
				this.buffers.set(index, buffer);
			}
			const within = absolute - index * this.partSize;
			const length = Math.min(data.length - offset, this.partSize - within);
			buffer.set(data.subarray(offset, offset + length), within);
			offset += length;
		}
		this.highWater = Math.max(this.highWater, position + data.length);
		await this.sendSettled();
	}

	private async sendSettled() {
		const current = Math.floor(this.highWater / this.partSize);
		for (const index of [...this.buffers.keys()].sort((a, b) => a - b)) {
			if (index < this.heldParts || index >= current - 1) continue;
			await this.sendPart(index, this.partSize);
		}
	}

	private async sendPart(index: number, length: number) {
		const buffer = this.buffers.get(index);
		if (!buffer) throw new Error("The MP4 writer left a gap in the file");
		this.buffers.delete(index);
		this.sent.add(index);
		await this.send(
			index + 1,
			length === buffer.length ? buffer : buffer.slice(0, length),
		);
	}

	async finish() {
		if (this.highWater === 0)
			throw new Error("The MP4 writer produced no data");
		const partCount = Math.ceil(this.highWater / this.partSize);
		for (let index = 0; index < partCount; index += 1) {
			if (this.sent.has(index)) continue;
			const length =
				index === partCount - 1
					? this.highWater - index * this.partSize
					: this.partSize;
			await this.sendPart(index, length);
		}
		return { size: this.highWater, partCount };
	}
}

function windowedReader(io: RemuxIo, windowSize: number) {
	const windows = new Map<number, Promise<Uint8Array>>();
	const load = (index: number) => {
		const cached = windows.get(index);
		if (cached) {
			windows.delete(index);
			windows.set(index, cached);
			return cached;
		}
		const offset = index * windowSize;
		const loading = io.read(offset, Math.min(windowSize, io.size - offset));
		windows.set(index, loading);
		if (windows.size > MAX_CACHED_WINDOWS) {
			const oldest = windows.keys().next().value;
			if (oldest !== undefined) windows.delete(oldest);
		}
		return loading;
	};

	return async (start: number, end: number) => {
		const result = new Uint8Array(end - start);
		let position = start;
		while (position < end) {
			const index = Math.floor(position / windowSize);
			const bytes = await load(index);
			const within = position - index * windowSize;
			const length = Math.min(end - position, bytes.length - within);
			if (length <= 0) throw new Error("The stored recording ended early");
			result.set(bytes.subarray(within, within + length), position - start);
			position += length;
		}
		return result;
	};
}

// The space for the index is set aside before any media is written, so the
// writer has to be told exactly how many packets each track will hold. The
// library's own estimate is too low for fragmented recordings.
async function countPackets(track: InputTrack | null) {
	if (!track) return undefined;
	let count = 0;
	const packets = new EncodedPacketSink(track).packets(undefined, undefined, {
		metadataOnly: true,
	});
	for await (const _packet of packets) count += 1;
	return count + PACKET_COUNT_MARGIN;
}

export async function remuxToSeekableMp4(
	io: RemuxIo,
	options: RemuxOptions = {},
): Promise<RemuxResult> {
	const partSize = options.partSize ?? DEFAULT_PART_SIZE;
	const writer = new PartWriter(
		partSize,
		options.heldParts ?? DEFAULT_HELD_PARTS,
		io.writePart,
	);
	const input = new Input({
		source: new CustomSource({
			getSize: () => io.size,
			read: windowedReader(io, options.readWindow ?? DEFAULT_READ_WINDOW),
		}),
		formats: [MP4],
	});
	try {
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "reserve" }),
			target: new StreamTarget(
				new WritableStream<StreamTargetChunk>({
					write: (chunk) => writer.write(chunk.data, chunk.position),
				}),
				{ chunked: true, chunkSize: partSize },
			),
		});
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				maximumPacketCount: await countPackets(
					await input.getPrimaryVideoTrack(),
				),
			},
			audio: {
				maximumPacketCount: await countPackets(
					await input.getPrimaryAudioTrack(),
				),
			},
			showWarnings: false,
		});
		if (!conversion.isValid)
			throw new Error("This recording cannot be rewritten as MP4");
		const durationSeconds = await input.computeDuration().catch(() => null);
		await conversion.execute();
		const written = await writer.finish();
		return {
			...written,
			durationSeconds:
				typeof durationSeconds === "number" &&
				Number.isFinite(durationSeconds) &&
				durationSeconds > 0
					? durationSeconds
					: null,
		};
	} finally {
		input.dispose();
	}
}
