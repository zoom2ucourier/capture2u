const MP4_CANDIDATES = [
	'video/mp4;codecs="avc1.640028,mp4a.40.2"',
	'video/mp4;codecs="avc1.4d401e,mp4a.40.2"',
	'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
	"video/mp4",
];
const WEBM_CANDIDATES = [
	"video/webm;codecs=vp9,opus",
	"video/webm;codecs=vp8,opus",
	"video/webm",
];

export interface RecordingFormat {
	mimeType: string;
	extension: "mp4" | "webm";
}

// MP4 (H.264 + AAC) first: it plays everywhere and can be made seekable in
// the browser without re-encoding. WebM is the fallback for browsers that
// cannot record MP4.
export function pickRecordingFormat(
	isSupported: (mimeType: string) => boolean = (mimeType) =>
		typeof MediaRecorder !== "undefined" &&
		MediaRecorder.isTypeSupported(mimeType),
): RecordingFormat | null {
	const mp4 = MP4_CANDIDATES.find(isSupported);
	if (mp4) return { mimeType: mp4, extension: "mp4" };
	const webm = WEBM_CANDIDATES.find(isSupported);
	if (webm) return { mimeType: webm, extension: "webm" };
	return null;
}

// MediaRecorder writes a fragmented MP4 with no duration or seek index.
// Rewriting the container (no re-encode, so it takes seconds) moves the index
// to the front, which is what makes the video seekable and quick to start.
export async function toSeekableMp4(source: Blob): Promise<Blob> {
	const {
		ALL_FORMATS,
		BlobSource,
		BufferTarget,
		Conversion,
		Input,
		Mp4OutputFormat,
		Output,
	} = await import("mediabunny");
	const input = new Input({
		source: new BlobSource(source),
		formats: ALL_FORMATS,
	});
	try {
		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		const conversion = await Conversion.init({ input, output });
		if (!conversion.isValid)
			throw new Error("This recording cannot be rewritten as MP4");
		await conversion.execute();
		if (!target.buffer || target.buffer.byteLength === 0)
			throw new Error("MP4 rewrite produced no data");
		return new Blob([target.buffer], { type: "video/mp4" });
	} finally {
		input.dispose();
	}
}

const MAX_THUMBNAIL_WIDTH = 1280;
const MAX_THUMBNAIL_HEIGHT = 720;

export function captureThumbnail(source: Blob): Promise<Blob | null> {
	return new Promise((resolve) => {
		const video = document.createElement("video");
		const url = URL.createObjectURL(source);
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.src = url;

		const finish = (result: Blob | null) => {
			window.clearTimeout(timeout);
			video.removeAttribute("src");
			video.load();
			URL.revokeObjectURL(url);
			resolve(result);
		};
		const timeout = window.setTimeout(() => finish(null), 10_000);

		video.addEventListener("error", () => finish(null), { once: true });
		video.addEventListener(
			"loadeddata",
			() => {
				const duration = Number.isFinite(video.duration) ? video.duration : 0;
				video.currentTime = duration > 0 ? Math.min(1, duration / 4) : 0;
			},
			{ once: true },
		);
		video.addEventListener(
			"seeked",
			() => {
				try {
					const width = video.videoWidth || 1280;
					const height = video.videoHeight || 720;
					const scale = Math.min(
						MAX_THUMBNAIL_WIDTH / width,
						MAX_THUMBNAIL_HEIGHT / height,
						1,
					);
					const canvas = document.createElement("canvas");
					canvas.width = Math.round(width * scale);
					canvas.height = Math.round(height * scale);
					const context = canvas.getContext("2d");
					if (!context) return finish(null);
					context.drawImage(video, 0, 0, canvas.width, canvas.height);
					canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.72);
				} catch {
					finish(null);
				}
			},
			{ once: true },
		);
	});
}
