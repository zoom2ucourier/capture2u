import { mergeRanges, type TimeRange } from "../../shared/timeline";
import type {
	Chapter,
	SuggestedCuts,
	TranscriptSegment,
} from "../../shared/types";

const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const SEGMENT_TARGET_SECONDS = 8;

export interface TimedWord {
	text: string;
	start: number;
	end: number;
}

const FILLER_PATTERN = /^(?:u+h+|u+m+|u+h+m+|e+r+m*|a+h+|h+m+|m+-?h+m+|mm+)$/;
const MAX_FILLER_SECONDS = 1.5;

export const isFillerWord = (word: TimedWord) =>
	word.end - word.start <= MAX_FILLER_SECONDS &&
	FILLER_PATTERN.test(word.text.toLowerCase().replace(/[^a-z-]/g, ""));

const SILENCE_MIN_SECONDS = 2;
const SILENCE_PADDING_SECONDS = 0.3;
const FILLER_PADDING_SECONDS = 0.03;
const MIN_SUGGESTED_SILENCE_SECONDS = 1;
const MAX_SUGGESTIONS = 300;

// Suggestions only: a pause is a stretch with no speech, and in a screen
// recording that can be the presenter showing something without talking, so
// nothing is hidden until the owner asks for it.
export function suggestCuts(
	words: TimedWord[],
	durationSeconds: number | null,
): SuggestedCuts {
	const spoken = words.filter((word) => !isFillerWord(word));
	const silences: TimeRange[] = [];
	const first = spoken[0];
	const last = spoken[spoken.length - 1];
	if (first && last) {
		if (first.start >= SILENCE_MIN_SECONDS)
			silences.push({ start: 0, end: first.start - SILENCE_PADDING_SECONDS });
		for (let index = 1; index < spoken.length; index += 1) {
			const previous = spoken[index - 1];
			const current = spoken[index];
			if (
				previous &&
				current &&
				current.start - previous.end >= SILENCE_MIN_SECONDS
			)
				silences.push({
					start: previous.end + SILENCE_PADDING_SECONDS,
					end: current.start - SILENCE_PADDING_SECONDS,
				});
		}
		if (
			durationSeconds !== null &&
			durationSeconds - last.end >= SILENCE_MIN_SECONDS
		)
			silences.push({
				start: last.end + SILENCE_PADDING_SECONDS,
				end: durationSeconds,
			});
	}
	const fillers = words.filter(isFillerWord).map((word) => ({
		start: Math.max(0, word.start - FILLER_PADDING_SECONDS),
		end: word.end + FILLER_PADDING_SECONDS,
	}));
	return {
		silences: mergeRanges(silences, MIN_SUGGESTED_SILENCE_SECONDS).slice(
			0,
			MAX_SUGGESTIONS,
		),
		fillers: mergeRanges(fillers).slice(0, MAX_SUGGESTIONS),
	};
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

function readWords(entries: unknown, scale: number): TimedWord[] {
	if (!Array.isArray(entries)) return [];
	const words: TimedWord[] = [];
	for (const entry of entries) {
		const item = asRecord(entry);
		const start = asNumber(item?.start);
		const end = asNumber(item?.end);
		const text =
			typeof item?.text === "string"
				? item.text
				: typeof item?.punctuated_word === "string"
					? item.punctuated_word
					: typeof item?.word === "string"
						? item.word
						: "";
		if (start === null || end === null || end < start || !text.trim()) continue;
		words.push({ text: text.trim(), start: start * scale, end: end * scale });
	}
	return words;
}

function deepgramAlternative(
	body: Record<string, unknown>,
): Record<string, unknown> | null {
	const results = asRecord(body.results);
	const channel = Array.isArray(results?.channels)
		? asRecord(results.channels[0])
		: null;
	const alternative = Array.isArray(channel?.alternatives)
		? asRecord(channel.alternatives[0])
		: null;
	if (!alternative) return null;
	return { text: alternative.transcript, words: alternative.words };
}

// Speech models return different shapes: Whisper gives `segments` in seconds,
// AssemblyAI gives `words` in milliseconds, Deepgram nests `words` in seconds
// under results.channels. Anything else falls back to one untimed block so a
// transcript is never lost to a shape change.
export function normalizeTranscript(
	raw: unknown,
	options: { timesInMilliseconds: boolean; durationSeconds?: number | null },
): { text: string; segments: TranscriptSegment[]; words: TimedWord[] } {
	const root = asRecord(raw) ?? {};
	const outer = asRecord(root.result) ?? asRecord(root.response) ?? root;
	const body = deepgramAlternative(outer) ?? outer;
	const scale = options.timesInMilliseconds ? 1 / 1000 : 1;

	const rawSegments = Array.isArray(body.segments) ? body.segments : null;
	if (rawSegments && rawSegments.length > 0) {
		const segments: TranscriptSegment[] = [];
		const words: TimedWord[] = [];
		for (const entry of rawSegments) {
			const item = asRecord(entry);
			const start = asNumber(item?.start);
			const end = asNumber(item?.end);
			const text = typeof item?.text === "string" ? item.text.trim() : "";
			if (start === null || end === null || !text) continue;
			segments.push({ start: start * scale, end: end * scale, text });
			words.push(...readWords(item?.words, scale));
		}
		if (segments.length > 0) {
			return {
				text:
					typeof body.text === "string" && body.text.trim()
						? body.text.trim()
						: segments.map((segment) => segment.text).join(" "),
				segments,
				words: words.length > 0 ? words : readWords(body.words, scale),
			};
		}
	}

	const words = readWords(body.words, scale);
	if (words.length > 0) {
		const spoken = words.filter((word) => !isFillerWord(word));
		const segments = groupWords(spoken);
		const hadFillers = spoken.length !== words.length;
		return {
			text:
				!hadFillers && typeof body.text === "string" && body.text.trim()
					? body.text.trim()
					: segments.map((segment) => segment.text).join(" "),
			segments,
			words,
		};
	}

	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return { text: "", segments: [], words: [] };
	return {
		text,
		segments: [{ start: 0, end: options.durationSeconds ?? 0, text }],
		words: [],
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
