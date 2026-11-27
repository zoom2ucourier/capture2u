import { beforeEach, describe, expect, it } from "vitest";
import {
	defaultSettings,
	type FailedRecording,
	loadFailedRecordings,
	loadOverlayTokens,
	loadSettings,
	loadSharedRecordingState,
	loadSharedUiState,
	registerOverlayToken,
	SETTINGS_KEY,
	saveSettings,
	saveSharedRecordingState,
	updateSharedUiState,
	upsertFailedRecording,
} from "./storage";

// chrome.storage resolves callbacks asynchronously, which is what lets
// concurrent read-modify-write calls interleave (both read before either
// writes). The fake reproduces that timing so the tests fail without the
// per-key write queue in storage.ts.
const createAsyncStorageArea = (
	getSetDelayMs: (writeIndex: number) => number = () => 0,
) => {
	const data = new Map<string, unknown>();
	let writeIndex = 0;
	return {
		get(keys: string[], callback: (items: Record<string, unknown>) => void) {
			const snapshot: Record<string, unknown> = {};
			for (const key of keys) {
				if (data.has(key)) snapshot[key] = data.get(key);
			}
			setTimeout(() => callback(snapshot), 0);
		},
		set(items: Record<string, unknown>, callback: () => void) {
			const delayMs = getSetDelayMs(writeIndex);
			writeIndex += 1;
			setTimeout(() => {
				for (const [key, value] of Object.entries(items)) {
					data.set(key, value);
				}
				callback();
			}, delayMs);
		},
		remove(keys: string[] | string, callback: () => void) {
			setTimeout(() => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					data.delete(key);
				}
				callback();
			}, 0);
		},
	};
};

const failedRecording = (sessionId: string): FailedRecording => ({
	sessionId,
	videoId: null,
	shareUrl: null,
	mimeType: "video/webm",
	subpath: null,
	durationMs: 1000,
	width: null,
	height: null,
	fps: null,
	totalBytes: 1024,
	createdAt: Date.now(),
	message: null,
});

beforeEach(() => {
	(globalThis as { chrome?: unknown }).chrome = {
		runtime: {},
		storage: {
			local: createAsyncStorageArea(),
			session: createAsyncStorageArea(),
		},
	};
});

describe("storage read-modify-write serialization", () => {
	it("keeps every overlay token registered by concurrent calls", async () => {
		await Promise.all([
			registerOverlayToken("token-a"),
			registerOverlayToken("token-b"),
			registerOverlayToken("token-c"),
		]);

		const tokens = await loadOverlayTokens();
		expect(Object.keys(tokens).sort()).toEqual([
			"token-a",
			"token-b",
			"token-c",
		]);
	});

	it("applies concurrent shared UI state updates without dropping either", async () => {
		await Promise.all([
			updateSharedUiState((current) => ({
				...current,
				panelOpen: true,
				updatedAt: Date.now(),
			})),
			updateSharedUiState((current) => ({
				...current,
				readyBarDismissed: true,
				updatedAt: Date.now(),
			})),
		]);

		const state = await loadSharedUiState();
		expect(state.panelOpen).toBe(true);
		expect(state.readyBarDismissed).toBe(true);
	});

	it("keeps every failed recording upserted by concurrent calls", async () => {
		await Promise.all([
			upsertFailedRecording(failedRecording("session-a")),
			upsertFailedRecording(failedRecording("session-b")),
		]);

		const recordings = await loadFailedRecordings();
		expect(recordings.map((entry) => entry.sessionId).sort()).toEqual([
			"session-a",
			"session-b",
		]);
	});

	it("keeps the newest recording status when an earlier write is slower", async () => {
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {},
			storage: {
				local: createAsyncStorageArea(),
				session: createAsyncStorageArea((writeIndex) =>
					writeIndex === 0 ? 20 : 0,
				),
			},
		};

		await Promise.all([
			saveSharedRecordingState({
				status: { phase: "creating" },
				plan: null,
				updatedAt: 1,
			}),
			saveSharedRecordingState({
				status: { phase: "idle" },
				plan: null,
				updatedAt: 2,
			}),
		]);

		expect((await loadSharedRecordingState())?.status.phase).toBe("idle");
	});
});

describe("settings", () => {
	it("points a fresh install at Capture2u with click highlights on", async () => {
		const settings = await loadSettings();

		expect(settings.apiBaseUrl).toBe("https://capture.locate2u.com");
		expect(settings.clickHighlights).toEqual({ enabled: true });
	});

	it("moves an install saved at the old address to the new one", async () => {
		await saveSettings({
			...defaultSettings,
			apiBaseUrl: "https://capture.locate2u.io",
		});
		expect((await loadSettings()).apiBaseUrl).toBe(
			"https://capture.locate2u.com",
		);

		await saveSettings({
			...defaultSettings,
			apiBaseUrl: "http://localhost:8787",
		});
		expect((await loadSettings()).apiBaseUrl).toBe("http://localhost:8787");
	});

	it("turns click highlights on for settings saved before the option existed", async () => {
		const { clickHighlights: _removed, ...older } = defaultSettings;
		await new Promise<void>((resolve) => {
			chrome.storage.local.set({ [SETTINGS_KEY]: older }, resolve);
		});

		expect((await loadSettings()).clickHighlights).toEqual({ enabled: true });
	});

	it("keeps click highlights off once switched off", async () => {
		await saveSettings({
			...defaultSettings,
			clickHighlights: { enabled: false },
		});

		expect((await loadSettings()).clickHighlights).toEqual({ enabled: false });
	});
});
