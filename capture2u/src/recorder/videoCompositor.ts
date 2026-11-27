export interface BubblePosition {
	x: number;
	y: number;
}

export interface BubblePositionRef {
	current: BubblePosition;
}

export interface FrameSize {
	width: number;
	height: number;
}

export interface VideoCompositor {
	track: MediaStreamTrack;
	ready: Promise<FrameSize>;
	stop: () => void;
}

interface TrackProcessor {
	readable: ReadableStream<VideoFrame>;
}

interface TrackGenerator extends MediaStreamTrack {
	writable: WritableStream<VideoFrame>;
}

interface InsertableStreamsScope {
	MediaStreamTrackProcessor?: new (init: {
		track: MediaStreamTrack;
	}) => TrackProcessor;
	MediaStreamTrackGenerator?: new (init: { kind: "video" }) => TrackGenerator;
}

export const BUBBLE_HEIGHT_FRACTION = 0.26;
export const DEFAULT_BUBBLE_POSITION: BubblePosition = { x: 0, y: 1 };

const BUBBLE_MARGIN_FRACTION = 0.03;
const MIN_FRAME_GAP_MS = 30;
const RING_FRACTION = 0.025;
const SETTLE_MS = 400;
const MAX_SETTLE_MS = 2500;
const FIRST_FRAME_TIMEOUT_MS = 5000;

const insertableStreams = () => globalThis as unknown as InsertableStreamsScope;

export const canCompositeVideo = () =>
	typeof insertableStreams().MediaStreamTrackProcessor === "function" &&
	typeof insertableStreams().MediaStreamTrackGenerator === "function" &&
	typeof VideoFrame === "function" &&
	typeof OffscreenCanvas === "function";

export const clampBubblePosition = (
	position: BubblePosition,
	width: number,
	height: number,
): BubblePosition => {
	if (width <= 0 || height <= 0) return position;
	const radius = (BUBBLE_HEIGHT_FRACTION * height) / 2;
	const margin = BUBBLE_MARGIN_FRACTION * height;
	const minX = (radius + margin) / width;
	const minY = (radius + margin) / height;
	return {
		x: Math.min(1 - minX, Math.max(minX, position.x)),
		y: Math.min(1 - minY, Math.max(minY, position.y)),
	};
};

// H.264 needs even dimensions.
export const evenSize = (width: number, height: number): FrameSize => ({
	width: Math.max(2, width - (width % 2)),
	height: Math.max(2, height - (height % 2)),
});

// Where a picture of one size sits inside a frame of another, scaled to fit
// and centred, with bars on the two spare sides.
export function containRect(source: FrameSize, target: FrameSize) {
	const scale = Math.min(
		target.width / source.width,
		target.height / source.height,
	);
	const width = Math.round(source.width * scale);
	const height = Math.round(source.height * scale);
	return {
		x: Math.round((target.width - width) / 2),
		y: Math.round((target.height - height) / 2),
		width,
		height,
	};
}

const pump = async (
	reader: ReadableStreamDefaultReader<VideoFrame>,
	onFrame: (frame: VideoFrame) => void,
) => {
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done || !value) return;
			onFrame(value);
		}
	} catch {
		return;
	}
};

// Everything that is recorded passes through here so the picture keeps one
// size from the first frame to the last. A shared screen, window or tab can
// change size as sharing starts or when the window is resized, and an MP4
// whose picture changes size part-way plays back frozen, green or garbled.
// The size is locked once it has held still for a moment; after that a
// picture of any other size is scaled to fit inside it.
export function createVideoCompositor({
	screenTrack,
	camera = null,
}: {
	screenTrack: MediaStreamTrack;
	camera?: { track: MediaStreamTrack; position: BubblePositionRef } | null;
}): VideoCompositor {
	const { MediaStreamTrackProcessor, MediaStreamTrackGenerator } =
		insertableStreams();
	if (!MediaStreamTrackProcessor || !MediaStreamTrackGenerator)
		throw new Error("This browser cannot process the recorded picture");

	const generator = new MediaStreamTrackGenerator({ kind: "video" });
	const writer = generator.writable.getWriter();
	const screenReader = new MediaStreamTrackProcessor({
		track: screenTrack,
	}).readable.getReader();
	const cameraReader = camera
		? new MediaStreamTrackProcessor({
				track: camera.track,
			}).readable.getReader()
		: null;
	const canvas = new OffscreenCanvas(2, 2);
	const context = canvas.getContext("2d");
	if (!context)
		throw new Error("This browser cannot process the recorded picture");

	let screenFrame: VideoFrame | null = null;
	let cameraFrame: VideoFrame | null = null;
	let stopped = false;
	let writing = false;
	let lastRenderAt = 0;
	let trailing: ReturnType<typeof setTimeout> | null = null;
	let locked: FrameSize | null = null;
	let candidate: FrameSize | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	let resolveReady: (size: FrameSize) => void = () => undefined;
	let rejectReady: (error: Error) => void = () => undefined;
	const ready = new Promise<FrameSize>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => undefined);

	const firstFrameTimer = setTimeout(() => {
		if (!candidate) rejectReady(new Error("No picture arrived to record"));
	}, FIRST_FRAME_TIMEOUT_MS);

	const drawBubble = (frame: VideoFrame, position: BubblePositionRef) => {
		const { width, height } = canvas;
		const center = clampBubblePosition(position.current, width, height);
		const diameter = BUBBLE_HEIGHT_FRACTION * height;
		const radius = diameter / 2;
		const centerX = center.x * width;
		const centerY = center.y * height;
		const side = Math.min(frame.displayWidth, frame.displayHeight);
		const sourceX = (frame.displayWidth - side) / 2;
		const sourceY = (frame.displayHeight - side) / 2;

		context.save();
		context.beginPath();
		context.arc(centerX, centerY, radius, 0, Math.PI * 2);
		context.clip();
		context.translate(centerX, centerY);
		context.scale(-1, 1);
		context.drawImage(
			frame,
			sourceX,
			sourceY,
			side,
			side,
			-radius,
			-radius,
			diameter,
			diameter,
		);
		context.restore();

		const ring = Math.max(2, diameter * RING_FRACTION);
		context.beginPath();
		context.arc(centerX, centerY, radius - ring / 2, 0, Math.PI * 2);
		context.lineWidth = ring;
		context.strokeStyle = "#ffffff";
		context.stroke();
	};

	const render = () => {
		if (stopped || writing || !locked || !screenFrame) return;
		const now = performance.now();
		if (now - lastRenderAt < MIN_FRAME_GAP_MS) {
			if (trailing === null)
				trailing = setTimeout(() => {
					trailing = null;
					render();
				}, MIN_FRAME_GAP_MS);
			return;
		}
		lastRenderAt = now;
		const source = {
			width: screenFrame.displayWidth,
			height: screenFrame.displayHeight,
		};
		if (source.width === locked.width && source.height === locked.height) {
			context.drawImage(screenFrame, 0, 0, locked.width, locked.height);
		} else {
			const fit = containRect(source, locked);
			context.fillStyle = "#000000";
			context.fillRect(0, 0, locked.width, locked.height);
			context.drawImage(screenFrame, fit.x, fit.y, fit.width, fit.height);
		}
		if (camera && cameraFrame) drawBubble(cameraFrame, camera.position);
		const output = new VideoFrame(canvas, {
			timestamp: Math.round(now * 1000),
		});
		writing = true;
		writer
			.write(output)
			.catch(() => output.close())
			.finally(() => {
				writing = false;
			});
	};

	const lock = () => {
		if (locked || stopped || !candidate) return;
		if (settleTimer !== null) clearTimeout(settleTimer);
		if (deadlineTimer !== null) clearTimeout(deadlineTimer);
		locked = evenSize(candidate.width, candidate.height);
		canvas.width = locked.width;
		canvas.height = locked.height;
		resolveReady(locked);
		render();
	};

	const watchSize = (frame: VideoFrame) => {
		if (locked) return;
		const size = { width: frame.displayWidth, height: frame.displayHeight };
		if (
			candidate &&
			candidate.width === size.width &&
			candidate.height === size.height
		)
			return;
		if (!candidate) {
			clearTimeout(firstFrameTimer);
			deadlineTimer = setTimeout(lock, MAX_SETTLE_MS);
		}
		candidate = size;
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = setTimeout(lock, SETTLE_MS);
	};

	void pump(screenReader, (frame) => {
		screenFrame?.close();
		screenFrame = frame;
		watchSize(frame);
		render();
	});
	if (cameraReader)
		void pump(cameraReader, (frame) => {
			cameraFrame?.close();
			cameraFrame = frame;
			render();
		});

	return {
		track: generator,
		ready,
		stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(firstFrameTimer);
			if (trailing !== null) clearTimeout(trailing);
			if (settleTimer !== null) clearTimeout(settleTimer);
			if (deadlineTimer !== null) clearTimeout(deadlineTimer);
			rejectReady(new Error("Recording was stopped"));
			void screenReader.cancel().catch(() => undefined);
			void cameraReader?.cancel().catch(() => undefined);
			void writer.close().catch(() => undefined);
			screenFrame?.close();
			cameraFrame?.close();
			screenFrame = null;
			cameraFrame = null;
			generator.stop();
		},
	};
}
