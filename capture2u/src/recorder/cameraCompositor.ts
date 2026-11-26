export interface BubblePosition {
	x: number;
	y: number;
}

export interface BubblePositionRef {
	current: BubblePosition;
}

export interface CameraCompositor {
	track: MediaStreamTrack;
	stop: () => void;
}

interface TrackProcessor {
	readable: ReadableStream<VideoFrame>;
}

interface TrackGenerator extends MediaStreamTrack {
	writable: WritableStream<VideoFrame>;
}

interface InsertableStreamsWindow {
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

const insertableStreams = () => window as unknown as InsertableStreamsWindow;

export const canCompositeCamera = () =>
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

export function createCameraCompositor({
	screenTrack,
	cameraTrack,
	position,
}: {
	screenTrack: MediaStreamTrack;
	cameraTrack: MediaStreamTrack;
	position: BubblePositionRef;
}): CameraCompositor {
	const { MediaStreamTrackProcessor, MediaStreamTrackGenerator } =
		insertableStreams();
	if (!MediaStreamTrackProcessor || !MediaStreamTrackGenerator)
		throw new Error("This browser cannot add the camera to the video");

	const generator = new MediaStreamTrackGenerator({ kind: "video" });
	const writer = generator.writable.getWriter();
	const screenReader = new MediaStreamTrackProcessor({
		track: screenTrack,
	}).readable.getReader();
	const cameraReader = new MediaStreamTrackProcessor({
		track: cameraTrack,
	}).readable.getReader();
	const canvas = new OffscreenCanvas(2, 2);
	const context = canvas.getContext("2d");
	if (!context)
		throw new Error("This browser cannot add the camera to the video");

	let screenFrame: VideoFrame | null = null;
	let cameraFrame: VideoFrame | null = null;
	let stopped = false;
	let writing = false;
	let lastRenderAt = 0;
	let trailing: number | null = null;

	const drawBubble = (camera: VideoFrame, width: number, height: number) => {
		const center = clampBubblePosition(position.current, width, height);
		const diameter = BUBBLE_HEIGHT_FRACTION * height;
		const radius = diameter / 2;
		const centerX = center.x * width;
		const centerY = center.y * height;
		const side = Math.min(camera.displayWidth, camera.displayHeight);
		const sourceX = (camera.displayWidth - side) / 2;
		const sourceY = (camera.displayHeight - side) / 2;

		context.save();
		context.beginPath();
		context.arc(centerX, centerY, radius, 0, Math.PI * 2);
		context.clip();
		context.translate(centerX, centerY);
		context.scale(-1, 1);
		context.drawImage(
			camera,
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
		if (stopped || writing || !screenFrame) return;
		const now = performance.now();
		if (now - lastRenderAt < MIN_FRAME_GAP_MS) {
			if (trailing === null)
				trailing = window.setTimeout(() => {
					trailing = null;
					render();
				}, MIN_FRAME_GAP_MS);
			return;
		}
		lastRenderAt = now;
		const width = screenFrame.displayWidth;
		const height = screenFrame.displayHeight;
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		context.drawImage(screenFrame, 0, 0, width, height);
		if (cameraFrame) drawBubble(cameraFrame, width, height);
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

	void pump(screenReader, (frame) => {
		screenFrame?.close();
		screenFrame = frame;
		render();
	});
	void pump(cameraReader, (frame) => {
		cameraFrame?.close();
		cameraFrame = frame;
		render();
	});

	return {
		track: generator,
		stop() {
			if (stopped) return;
			stopped = true;
			if (trailing !== null) window.clearTimeout(trailing);
			void screenReader.cancel().catch(() => undefined);
			void cameraReader.cancel().catch(() => undefined);
			void writer.close().catch(() => undefined);
			screenFrame?.close();
			cameraFrame?.close();
			screenFrame = null;
			cameraFrame = null;
			generator.stop();
		},
	};
}
