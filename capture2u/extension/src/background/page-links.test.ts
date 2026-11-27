import { describe, expect, it } from "vitest";
import type { RecordingStatus } from "../shared/types";
import {
	addPage,
	PageLinkTracker,
	type RecordedPage,
	recordingSeconds,
} from "./page-links";

const recording = (durationMs: number, updatedAt: number): RecordingStatus => ({
	phase: "recording",
	videoId: "abc123def456" as never,
	startedAt: 0,
	durationMs,
	updatedAt,
});

describe("addPage", () => {
	it("adds a new page and fills in a late title", () => {
		let pages = addPage([], { url: "https://a.com/", title: null, at: 0 });
		pages = addPage(pages, { url: "https://a.com/", title: "A", at: 3 });
		expect(pages).toEqual([{ url: "https://a.com/", title: "A", at: 0 }]);
	});

	it("replaces a page that was only on screen for a moment", () => {
		let pages = addPage([], { url: "https://a.com/", title: null, at: 5 });
		pages = addPage(pages, { url: "https://b.com/", title: "B", at: 5.5 });
		expect(pages).toEqual([{ url: "https://b.com/", title: "B", at: 5 }]);
	});
});

describe("recordingSeconds", () => {
	it("counts time since the last update while recording", () => {
		expect(recordingSeconds(recording(10_000, 1_000), 3_000)).toBe(12);
	});

	it("is unknown outside a recording", () => {
		expect(recordingSeconds({ phase: "idle" }, 0)).toBeNull();
	});
});

describe("PageLinkTracker", () => {
	it("sends the pages once the recording starts uploading", async () => {
		const sent: { videoId: string; pages: RecordedPage[] }[] = [];
		let tab = { url: "https://docs.example.com/start", title: "Start" };
		let now = 0;
		const tracker = new PageLinkTracker(
			async () => tab,
			async (videoId, pages) => {
				sent.push({ videoId, pages });
			},
			() => now,
		);
		tracker.begin({ mode: "fullscreen", tabId: null });
		tracker.onStatus({ phase: "creating" });
		tracker.onStatus(recording(0, 0));
		await tracker.noteCurrentPage();
		now = 20_000;
		tab = { url: "chrome://settings", title: "Settings" };
		await tracker.noteCurrentPage();
		tab = { url: "https://app.example.com/orders", title: "Orders" };
		await tracker.noteCurrentPage();
		tracker.onStatus({
			phase: "uploading",
			videoId: "abc123def456" as never,
			startedAt: 0,
			durationMs: 30_000,
			updatedAt: 30_000,
		});
		tracker.onStatus({
			phase: "completed",
			videoId: "abc123def456" as never,
			shareUrl: "https://x/v/abc123def456",
		});
		expect(sent).toEqual([
			{
				videoId: "abc123def456",
				pages: [
					{ url: "https://docs.example.com/start", title: "Start", at: 0 },
					{ url: "https://app.example.com/orders", title: "Orders", at: 20 },
				],
			},
		]);
	});

	it("records nothing for a camera-only recording", async () => {
		const sent: unknown[] = [];
		const tracker = new PageLinkTracker(
			async () => ({ url: "https://a.com/" }),
			async (_videoId, pages) => {
				sent.push(pages);
			},
			() => 0,
		);
		tracker.begin({ mode: "camera", tabId: null });
		tracker.onStatus(recording(0, 0));
		await tracker.noteCurrentPage();
		tracker.onStatus({
			phase: "completed",
			videoId: "abc123def456" as never,
			shareUrl: "https://x",
		});
		expect(sent).toEqual([]);
	});
});
