// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fitThumbnailSize,
	startThumbnailCapture,
	THUMBNAIL_MAX_BYTES,
} from "./thumbnail";

type FakeVideo = {
	muted: boolean;
	playsInline: boolean;
	srcObject: unknown;
	readyState: number;
	videoWidth: number;
	videoHeight: number;
	play: () => Promise<void>;
	pause: () => void;
};

type FakeCanvas = {
	width: number;
	height: number;
	getContext: () => { drawImage: ReturnType<typeof vi.fn> } | null;
	toBlob: (
		callback: (blob: Blob | null) => void,
		type: string,
		quality: number,
	) => void;
};

let video: FakeVideo;
let canvases: FakeCanvas[];
let drawImage: ReturnType<typeof vi.fn>;
let encodedSizes: (quality: number) => number;
let qualities: number[];

const track = { readyState: "ended" } as MediaStreamTrack;

const flush = async () => {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

beforeEach(() => {
	vi.useFakeTimers();
	canvases = [];
	qualities = [];
	drawImage = vi.fn();
	encodedSizes = () => 1000;
	video = {
		muted: false,
		playsInline: false,
		srcObject: null,
		readyState: 4,
		videoWidth: 2560,
		videoHeight: 1440,
		play: () => Promise.resolve(),
		pause: () => undefined,
	};
	vi.stubGlobal(
		"MediaStream",
		class {
			constructor(readonly tracks: MediaStreamTrack[]) {}
		},
	);
	vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag === "video") return video;
		const canvas: FakeCanvas = {
			width: 0,
			height: 0,
			getContext: () => ({ drawImage }),
			toBlob: (callback, type, quality) => {
				qualities.push(quality);
				callback(new Blob([new Uint8Array(encodedSizes(quality))], { type }));
			},
		};
		canvases.push(canvas);
		return canvas;
	}) as typeof document.createElement);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("thumbnail size", () => {
	it.each([
		[2560, 1440, 1280, 720],
		[1920, 1200, 1152, 720],
		[3440, 1440, 1280, 536],
		[800, 600, 800, 600],
		[1080, 1920, 405, 720],
	])("fits %dx%d inside 1280x720 as %dx%d", (width, height, fitW, fitH) => {
		expect(fitThumbnailSize(width, height)).toEqual({
			width: fitW,
			height: fitH,
		});
	});
});

describe("thumbnail capture", () => {
	it("uploads one scaled JPEG shortly after the recording starts", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		startThumbnailCapture({ track, upload, delayMs: 1000 });

		await vi.advanceTimersByTimeAsync(999);
		expect(upload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await flush();

		expect(upload).toHaveBeenCalledTimes(1);
		expect(upload.mock.calls[0]?.[0].type).toBe("image/jpeg");
		expect(canvases[0]).toMatchObject({ width: 1280, height: 720 });
		expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
		expect(video.srcObject).toBeNull();
	});

	it("waits for the first frame before taking the picture", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		video.readyState = 0;
		video.videoWidth = 0;
		startThumbnailCapture({ track, upload, delayMs: 1000 });

		await vi.advanceTimersByTimeAsync(1500);
		expect(upload).not.toHaveBeenCalled();

		video.readyState = 4;
		video.videoWidth = 1280;
		video.videoHeight = 720;
		await vi.advanceTimersByTimeAsync(250);
		await flush();

		expect(upload).toHaveBeenCalledTimes(1);
	});

	it("lowers the quality until the picture is within 2 MB", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		encodedSizes = (quality) =>
			quality > 0.5 ? THUMBNAIL_MAX_BYTES + 1 : THUMBNAIL_MAX_BYTES;
		startThumbnailCapture({ track, upload, delayMs: 0 });

		await vi.advanceTimersByTimeAsync(0);
		await flush();

		expect(qualities).toEqual([0.82, 0.6, 0.4]);
		expect(upload.mock.calls[0]?.[0].size).toBe(THUMBNAIL_MAX_BYTES);
	});

	it("takes the picture straight away when the recording stops early", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		const capture = startThumbnailCapture({ track, upload, delayMs: 1000 });

		capture.captureNow();
		await flush();
		expect(upload).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(5000);
		capture.captureNow();
		await flush();
		expect(upload).toHaveBeenCalledTimes(1);
	});

	it("uploads nothing once disposed", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		const capture = startThumbnailCapture({ track, upload, delayMs: 1000 });

		capture.dispose();
		await vi.advanceTimersByTimeAsync(10_000);
		capture.captureNow();
		await flush();

		expect(upload).not.toHaveBeenCalled();
	});

	it("gives up quietly when no frame ever arrives", async () => {
		const upload = vi.fn(async (_image: Blob) => undefined);
		video.readyState = 0;
		video.videoWidth = 0;
		startThumbnailCapture({ track, upload, delayMs: 1000 });

		await vi.advanceTimersByTimeAsync(60_000);
		await flush();

		expect(upload).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		["the upload is refused", () => undefined],
		[
			"the canvas cannot be drawn",
			() => {
				drawImage.mockImplementation(() => {
					throw new Error("tainted");
				});
			},
		],
		[
			"the page cannot create a video",
			() => {
				vi.mocked(document.createElement).mockImplementation(() => {
					throw new Error("no document");
				});
			},
		],
	])("never throws or rejects when %s", async (_name, arrange) => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		arrange();
		const upload = vi.fn(async (_image: Blob) => {
			throw new Error("413");
		});

		expect(() => {
			const capture = startThumbnailCapture({ track, upload, delayMs: 0 });
			capture.captureNow();
			capture.dispose();
		}).not.toThrow();
		await vi.advanceTimersByTimeAsync(10_000);
		await flush();
		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 0));
		process.off("unhandledRejection", onRejection);

		expect(rejections).toEqual([]);
	});
});
