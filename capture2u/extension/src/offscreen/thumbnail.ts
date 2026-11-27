export const THUMBNAIL_MAX_WIDTH = 1280;
export const THUMBNAIL_MAX_HEIGHT = 720;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

// Late enough that the countdown and the share picker are off screen, early
// enough that a short recording still gets its picture.
const CAPTURE_DELAY_MS = 1200;
const FRAME_POLL_INTERVAL_MS = 250;
const FRAME_POLL_ATTEMPTS = 20;
const TRACK_FRAME_TIMEOUT_MS = 2000;
const JPEG_QUALITIES = [0.82, 0.6, 0.4, 0.25];

type FrameSource = CanvasImageSource & { close?: () => void };

type TrackProcessor = {
	readable: ReadableStream<VideoFrame>;
};

type TrackProcessorConstructor = new (init: {
	track: MediaStreamTrack;
	maxBufferSize?: number;
}) => TrackProcessor;

export type ThumbnailCapture = {
	// Takes the picture immediately if the timer has not done so yet. Called
	// when a recording stops early, while the captured track is still live.
	captureNow: () => void;
	dispose: () => void;
};

export const fitThumbnailSize = (width: number, height: number) => {
	const scale = Math.min(
		1,
		THUMBNAIL_MAX_WIDTH / width,
		THUMBNAIL_MAX_HEIGHT / height,
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
};

const encodeJpeg = (canvas: HTMLCanvasElement, quality: number) =>
	new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, "image/jpeg", quality);
	});

const renderJpeg = async (
	source: FrameSource,
	sourceWidth: number,
	sourceHeight: number,
) => {
	if (sourceWidth <= 0 || sourceHeight <= 0) return null;
	const { width, height } = fitThumbnailSize(sourceWidth, sourceHeight);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) return null;
	context.drawImage(source, 0, 0, width, height);
	for (const quality of JPEG_QUALITIES) {
		const blob = await encodeJpeg(canvas, quality);
		if (blob && blob.size > 0 && blob.size <= THUMBNAIL_MAX_BYTES) return blob;
	}
	return null;
};

const readTrackFrame = async (track: MediaStreamTrack) => {
	const Processor = (
		globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor }
	).MediaStreamTrackProcessor;
	if (!Processor || track.readyState !== "live") return null;
	const clone = track.clone();
	const reader = new Processor({
		track: clone,
		maxBufferSize: 1,
	}).readable.getReader();
	let timer = 0;
	try {
		const result = await Promise.race([
			reader.read(),
			new Promise<null>((resolve) => {
				timer = window.setTimeout(() => resolve(null), TRACK_FRAME_TIMEOUT_MS);
			}),
		]);
		return result?.value ?? null;
	} finally {
		window.clearTimeout(timer);
		void reader.cancel().catch(() => undefined);
		clone.stop();
	}
};

// Grabs one frame of the picture being recorded and hands it to `upload` as a
// JPEG no larger than 1280x720 and 2 MB. The server cannot make thumbnails,
// so this is where a recording gets one. Nothing here may disturb the
// recording: every failure is swallowed and the video simply has no picture.
export const startThumbnailCapture = ({
	track,
	upload,
	delayMs = CAPTURE_DELAY_MS,
}: {
	track: MediaStreamTrack;
	upload: (image: Blob) => Promise<void>;
	delayMs?: number;
}): ThumbnailCapture => {
	let settled = false;
	let timer: number | null = null;
	let video: HTMLVideoElement | null = null;

	const release = () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		if (video) {
			video.pause();
			video.srcObject = null;
			video = null;
		}
	};

	const deliver = (image: Promise<Blob | null>) => {
		void image
			.then((blob) => (blob ? upload(blob) : undefined))
			.catch(() => undefined);
	};

	const captureFromVideo = () => {
		if (!video || video.readyState < 2 || video.videoWidth === 0) return false;
		deliver(renderJpeg(video, video.videoWidth, video.videoHeight));
		return true;
	};

	const captureFromTrack = () => {
		deliver(
			readTrackFrame(track).then(async (frame) => {
				if (!frame) return null;
				try {
					return await renderJpeg(
						frame,
						frame.displayWidth,
						frame.displayHeight,
					);
				} finally {
					frame.close();
				}
			}),
		);
	};

	const finish = (allowTrackFallback: boolean) => {
		if (settled) return;
		settled = true;
		try {
			if (!captureFromVideo() && allowTrackFallback) captureFromTrack();
		} catch {
		} finally {
			release();
		}
	};

	const poll = (attemptsLeft: number) => {
		timer = null;
		if (settled) return;
		const ready =
			video !== null && video.readyState >= 2 && video.videoWidth > 0;
		if (ready || attemptsLeft <= 0) {
			finish(true);
			return;
		}
		timer = window.setTimeout(
			() => poll(attemptsLeft - 1),
			FRAME_POLL_INTERVAL_MS,
		);
	};

	try {
		video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = new MediaStream([track]);
		void video.play().catch(() => undefined);
		timer = window.setTimeout(() => poll(FRAME_POLL_ATTEMPTS), delayMs);
	} catch {
		settled = true;
		release();
	}

	return {
		captureNow: () => finish(false),
		dispose: () => {
			settled = true;
			release();
		},
	};
};
