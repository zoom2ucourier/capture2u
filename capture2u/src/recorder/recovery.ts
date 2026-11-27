import {
	deleteRecoveredRecordingSpool,
	listRecordingSpoolSessions,
	RECORDING_SPOOL_LIVE_MIN_IDLE_MS,
	recoverRecordingSpoolSession,
} from "@cap/recorder-core/recording-spool";
import { refusedStartStatus } from "../../shared/uploads";
import { captureThumbnail, probeVideoFile, toSeekableMp4 } from "./media";
import {
	type CreatedVideo,
	createVideo,
	uploadThumbnail,
	uploadWholeFile,
} from "./upload";

// While a recording is being made its pieces are also written to this
// browser's own storage. If the tab is closed or the browser crashes, the
// pieces are still there the next time the app is opened.

export interface RecordingMeta {
	videoId: string | null;
	shareUrl: string | null;
	extension: "mp4" | "webm";
	width?: number;
	height?: number;
	startedAt: number;
	elapsedMs: number;
}

export interface RecoverableRecording {
	sessionId: string;
	mimeType: string;
	totalBytes: number;
	updatedAt: number;
	meta: RecordingMeta | null;
}

const META_KEY = "capture2u.recordings";
const LOCK_PREFIX = "capture2u-recording:";
const STALE_META_MS = 24 * 60 * 60 * 1000;
// Chrome hands over the file header first and the picture only every five
// seconds, starting about ten seconds in. A backup this small is a header
// with nothing to watch in it, so it is thrown away instead of offered.
const MIN_RECOVERABLE_BYTES = 16 * 1024;

export const recordingLockName = (sessionId: string) =>
	`${LOCK_PREFIX}${sessionId}`;

const readAllMeta = (): Record<string, RecordingMeta> => {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(META_KEY) ?? "{}",
		);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, RecordingMeta>)
			: {};
	} catch {
		return {};
	}
};

const writeAllMeta = (all: Record<string, RecordingMeta>) => {
	try {
		window.localStorage.setItem(META_KEY, JSON.stringify(all));
	} catch {
		return;
	}
};

export function saveRecordingMeta(sessionId: string, meta: RecordingMeta) {
	writeAllMeta({ ...readAllMeta(), [sessionId]: meta });
}

export function removeRecordingMeta(sessionId: string) {
	const all = readAllMeta();
	delete all[sessionId];
	writeAllMeta(all);
}

async function liveSessionIds(): Promise<Set<string> | null> {
	if (!navigator.locks?.query) return null;
	try {
		const snapshot = await navigator.locks.query();
		return new Set(
			(snapshot.held ?? [])
				.map((lock) => lock.name ?? "")
				.filter((name) => name.startsWith(LOCK_PREFIX))
				.map((name) => name.slice(LOCK_PREFIX.length)),
		);
	} catch {
		return null;
	}
}

export async function findRecoverableRecordings(
	now: number = Date.now(),
): Promise<RecoverableRecording[]> {
	if (typeof indexedDB === "undefined") return [];
	let sessions: Awaited<ReturnType<typeof listRecordingSpoolSessions>>;
	try {
		sessions = await listRecordingSpoolSessions();
	} catch {
		return [];
	}
	const live = await liveSessionIds();
	const meta = readAllMeta();
	const known = new Set(sessions.map((session) => session.sessionId));
	for (const [sessionId, entry] of Object.entries(meta))
		if (!known.has(sessionId) && now - entry.startedAt > STALE_META_MS)
			removeRecordingMeta(sessionId);
	const found: RecoverableRecording[] = [];
	for (const session of sessions) {
		const isLive = live
			? live.has(session.sessionId)
			: now - session.updatedAt < RECORDING_SPOOL_LIVE_MIN_IDLE_MS;
		if (isLive) continue;
		if (session.totalBytes < MIN_RECOVERABLE_BYTES) {
			await deleteRecoveredRecordingSpool(session.sessionId).catch(
				() => undefined,
			);
			removeRecordingMeta(session.sessionId);
			continue;
		}
		found.push({
			sessionId: session.sessionId,
			mimeType: session.mimeType,
			totalBytes: session.totalBytes,
			updatedAt: session.updatedAt,
			meta: meta[session.sessionId] ?? null,
		});
	}
	return found;
}

export async function discardRecoverableRecording(sessionId: string) {
	await deleteRecoveredRecordingSpool(sessionId);
	removeRecordingMeta(sessionId);
}

export async function readRecoverableRecording(
	recording: RecoverableRecording,
) {
	const recovered = await recoverRecordingSpoolSession(recording.sessionId);
	if (!recovered)
		throw new Error("That recording is no longer on this computer");
	const extension: "mp4" | "webm" =
		recording.meta?.extension ??
		(recording.mimeType.includes("webm") ? "webm" : "mp4");
	const type = extension === "mp4" ? "video/mp4" : "video/webm";
	let blob = new Blob([recovered.blob], { type });
	let seekable = false;
	if (extension === "mp4") {
		try {
			blob = await toSeekableMp4(blob);
			seekable = true;
		} catch (cause) {
			console.warn("Uploading the recovered recording as it was saved", cause);
		}
	}
	return { blob, extension, contentType: type, seekable };
}

export async function recoverRecording(
	recording: RecoverableRecording,
	onProgress?: (fraction: number) => void,
): Promise<CreatedVideo> {
	const { blob, extension, contentType, seekable } =
		await readRecoverableRecording(recording);
	const info = seekable ? await probeVideoFile(blob) : {};
	const upload = (videoId: string) =>
		uploadWholeFile({
			videoId,
			blob,
			subpath: `video.${extension}`,
			contentType,
			durationSeconds: info.durationSeconds,
			width: info.width ?? recording.meta?.width,
			height: info.height ?? recording.meta?.height,
			seekable,
			onProgress,
		});

	let video: CreatedVideo | null =
		recording.meta?.videoId && recording.meta.shareUrl
			? { id: recording.meta.videoId, shareUrl: recording.meta.shareUrl }
			: null;
	let alreadyStored = false;
	if (video) {
		try {
			await upload(video.id);
		} catch (cause) {
			const status = refusedStartStatus(cause);
			if (status === 409) alreadyStored = true;
			else if (status === 403 || status === 404) video = null;
			else throw cause;
		}
	}
	if (!video) {
		video = await createVideo();
		await upload(video.id);
	}

	if (seekable && !alreadyStored) {
		const thumbnail = await captureThumbnail(blob);
		if (thumbnail) await uploadThumbnail(video.id, thumbnail);
	}
	await discardRecoverableRecording(recording.sessionId).catch(() => undefined);
	return video;
}
