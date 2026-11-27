import type { RecordingMode, RecordingStatus } from "../shared/types";

export type RecordedPage = { url: string; title: string | null; at: number };

export type PageTarget = { mode: RecordingMode; tabId: number | null };

type PageTab = { url?: string; title?: string };

const MAX_PAGES = 100;
// A page that redirects or is replaced this quickly was never really shown,
// so the new address takes its place.
const REPLACE_WITHIN_SECONDS = 1.5;

export const isWebPageUrl = (url: string | undefined): url is string =>
	typeof url === "string" && /^https?:\/\//i.test(url);

export function addPage(pages: RecordedPage[], next: RecordedPage) {
	const last = pages[pages.length - 1];
	if (last && last.url === next.url) {
		if (!last.title && next.title)
			return [...pages.slice(0, -1), { ...last, title: next.title }];
		return pages;
	}
	if (last && next.at - last.at < REPLACE_WITHIN_SECONDS)
		return [...pages.slice(0, -1), { ...next, at: last.at }];
	if (pages.length >= MAX_PAGES) return pages;
	return [...pages, next];
}

export function recordingSeconds(status: RecordingStatus, now: number) {
	if (status.phase === "paused") return status.durationMs / 1000;
	if (status.phase !== "recording") return null;
	return (status.durationMs + Math.max(0, now - status.updatedAt)) / 1000;
}

// Keeps the list of web pages shown while recording, with the moment each one
// came on screen, and hands it to the server once the recording ends. A tab
// recording follows only its own tab; a screen or window recording follows
// whichever tab is in front.
export class PageLinkTracker {
	private target: PageTarget | null = null;
	private status: RecordingStatus = { phase: "idle" };
	private videoId: string | null = null;
	private pages: RecordedPage[] = [];
	private sent = false;

	constructor(
		private readonly findTab: (target: PageTarget) => Promise<PageTab | null>,
		private readonly send: (
			videoId: string,
			pages: RecordedPage[],
		) => Promise<void>,
		private readonly now: () => number = Date.now,
	) {}

	begin(target: PageTarget) {
		this.target = target.mode === "camera" ? null : target;
		this.reset();
	}

	onStatus(status: RecordingStatus) {
		const previous = this.status;
		this.status = status;
		if (!this.target) return;

		if (status.phase === "creating") {
			this.reset();
			return;
		}

		const live = status.phase === "recording" || status.phase === "paused";
		if (live && status.videoId && status.videoId !== this.videoId) {
			if (this.videoId) this.reset();
			this.videoId = status.videoId;
		}
		if (
			status.phase === "recording" &&
			previous.phase !== "recording" &&
			previous.phase !== "paused"
		)
			void this.noteCurrentPage();

		if (
			status.phase === "uploading" ||
			status.phase === "completed" ||
			status.phase === "error"
		) {
			this.flush(status.videoId ?? this.videoId);
		}
		if (status.phase === "idle" || status.phase === "error") {
			this.target = null;
		}
	}

	async noteCurrentPage() {
		const target = this.target;
		if (!target) return;
		if (recordingSeconds(this.status, this.now()) === null) return;
		const tab = await this.findTab(target).catch(() => null);
		const at = recordingSeconds(this.status, this.now());
		if (!tab || !isWebPageUrl(tab.url) || at === null || this.sent) return;
		this.pages = addPage(this.pages, {
			url: tab.url,
			title: tab.title?.trim() || null,
			at: Math.round(at * 10) / 10,
		});
	}

	private flush(videoId: string | null | undefined) {
		if (this.sent || !videoId || this.pages.length === 0) return;
		this.sent = true;
		const pages = this.pages;
		void this.send(videoId, pages).catch((error) => {
			console.warn("[capture2u] could not save the recorded pages", error);
		});
	}

	private reset() {
		this.videoId = null;
		this.pages = [];
		this.sent = false;
	}
}
