import type { Chapter, TranscriptSegment } from "../../shared/types";

const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const SEGMENT_TARGET_SECONDS = 8;

interface TimedWord {
	text: string;
	start: number;
	end: number;
}

function groupWords(words: TimedWord[]): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	let current: TimedWord[] = [];
	const flush = () => {
		const first = current[0];
		const last = current[current.length - 1];
		if (!first || !last) return;
		segments.push({
			start: first.start,
			end: last.end,
			text: current
				.map((word) => word.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim(),
		});
		current = [];
	};
	for (const word of words) {
		current.push(word);
		const first = current[0];
		if (!first) continue;
		const long = word.end - first.start >= SEGMENT_TARGET_SECONDS;
		const sentenceEnd = /[.!?]$/.test(word.text);
		if (long || (sentenceEnd && word.end - first.start >= 3)) flush();
	}
	flush();
	return segments;
}

// Speech models return different shapes: Whisper gives `segments` in seconds,
// AssemblyAI gives `words` in milliseconds. Anything else falls back to one
// untimed block so a transcript is never lost to a shape change.
export function normalizeTranscript(
	raw: unknown,
	options: { timesInMilliseconds: boolean; durationSeconds?: number | null },
): { text: string; segments: TranscriptSegment[] } {
	const root = asRecord(raw) ?? {};
	const body = asRecord(root.result) ?? asRecord(root.response) ?? root;
	const scale = options.timesInMilliseconds ? 1 / 1000 : 1;

	const rawSegments = Array.isArray(body.segments) ? body.segments : null;
	if (rawSegments && rawSegments.length > 0) {
		const segments: TranscriptSegment[] = [];
		for (const entry of rawSegments) {
			const item = asRecord(entry);
			const start = asNumber(item?.start);
			const end = asNumber(item?.end);
			const text = typeof item?.text === "string" ? item.text.trim() : "";
			if (start === null || end === null || !text) continue;
			segments.push({ start: start * scale, end: end * scale, text });
		}
		if (segments.length > 0) {
			return {
				text:
					typeof body.text === "string" && body.text.trim()
						? body.text.trim()
						: segments.map((segment) => segment.text).join(" "),
				segments,
			};
		}
	}

	const rawWords = Array.isArray(body.words) ? body.words : null;
	if (rawWords && rawWords.length > 0) {
		const words: TimedWord[] = [];
		for (const entry of rawWords) {
			const item = asRecord(entry);
			const start = asNumber(item?.start);
			const end = asNumber(item?.end);
			const text =
				typeof item?.text === "string"
					? item.text
					: typeof item?.word === "string"
						? item.word
						: "";
			if (start === null || end === null || !text.trim()) continue;
			words.push({ text: text.trim(), start: start * scale, end: end * scale });
		}
		if (words.length > 0) {
			const segments = groupWords(words);
			return {
				text:
					typeof body.text === "string" && body.text.trim()
						? body.text.trim()
						: segments.map((segment) => segment.text).join(" "),
				segments,
			};
		}
	}

	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return { text: "", segments: [] };
	return {
		text,
		segments: [{ start: 0, end: options.durationSeconds ?? 0, text }],
	};
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function formatVttTime(seconds: number) {
	const safe = Math.max(0, seconds);
	const totalMs = Math.round(safe * 1000);
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const secs = Math.floor((totalMs % 60_000) / 1000);
	return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(totalMs % 1000, 3)}`;
}

export function segmentsToVtt(segments: TranscriptSegment[]) {
	const cues = segments
		.filter((segment) => segment.end > segment.start && segment.text)
		.map(
			(segment, index) =>
				`${index + 1}\n${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n${segment.text.replace(/-->/g, "->")}`,
		);
	return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

export const formatClock = (seconds: number) => {
	const total = Math.max(0, Math.floor(seconds));
	return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

export function transcriptForPrompt(
	segments: TranscriptSegment[],
	maxChars: number,
) {
	let output = "";
	for (const segment of segments) {
		const line = `[${formatClock(segment.start)}] ${segment.text}\n`;
		if (output.length + line.length > maxChars) break;
		output += line;
	}
	return output;
}

export interface AiSummary {
	title: string | null;
	summary: string | null;
	chapters: Chapter[];
}

export function parseAiSummary(
	raw: unknown,
	durationSeconds: number | null,
): AiSummary {
	const root = asRecord(raw) ?? {};
	let payload: unknown = root.response ?? root.result ?? root;
	if (typeof payload === "string") {
		const start = payload.indexOf("{");
		const end = payload.lastIndexOf("}");
		try {
			payload =
				start >= 0 && end > start
					? JSON.parse(payload.slice(start, end + 1))
					: {};
		} catch {
			payload = {};
		}
	}
	const body = asRecord(payload) ?? {};
	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title
					.trim()
					.replace(/^["']|["']$/g, "")
					.slice(0, 120)
			: null;
	const summary =
		typeof body.summary === "string" && body.summary.trim()
			? body.summary.trim().slice(0, 4000)
			: null;
	const chapters: Chapter[] = [];
	if (Array.isArray(body.chapters)) {
		for (const entry of body.chapters) {
			const item = asRecord(entry);
			const start = asNumber(item?.start);
			const chapterTitle =
				typeof item?.title === "string" ? item.title.trim() : "";
			if (start === null || start < 0 || !chapterTitle) continue;
			if (durationSeconds && start > durationSeconds) continue;
			chapters.push({ title: chapterTitle.slice(0, 120), start });
		}
	}
	chapters.sort((left, right) => left.start - right.start);
	return { title, summary, chapters: chapters.slice(0, 20) };
}
