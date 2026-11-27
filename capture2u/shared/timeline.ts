export interface TimeRange {
	start: number;
	end: number;
}

const MERGE_GAP_SECONDS = 0.05;

const round = (value: number) => Math.round(value * 100) / 100;

export function mergeRanges(ranges: TimeRange[], minLength = 0): TimeRange[] {
	const sorted = ranges
		.filter(
			(range) =>
				Number.isFinite(range.start) &&
				Number.isFinite(range.end) &&
				range.end > range.start,
		)
		.map((range) => ({ start: round(range.start), end: round(range.end) }))
		.sort((left, right) => left.start - right.start);

	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + MERGE_GAP_SECONDS)
			last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged.filter((range) => range.end - range.start >= minLength);
}

export function keptRanges(
	durationSeconds: number,
	trimStart: number | null,
	trimEnd: number | null,
	cuts: TimeRange[],
): TimeRange[] {
	const from = Math.max(0, trimStart ?? 0);
	const to = Math.min(trimEnd ?? durationSeconds, durationSeconds);
	if (!(to > from)) return [];

	const kept: TimeRange[] = [];
	let cursor = from;
	for (const cut of mergeRanges(cuts)) {
		if (cut.end <= cursor) continue;
		if (cut.start >= to) break;
		if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
		cursor = Math.max(cursor, cut.end);
	}
	if (cursor < to) kept.push({ start: cursor, end: to });
	return kept;
}

export const keptTotal = (kept: TimeRange[]) =>
	kept.reduce((total, range) => total + (range.end - range.start), 0);

export function toVirtual(kept: TimeRange[], absolute: number) {
	let elapsed = 0;
	for (const range of kept) {
		if (absolute <= range.start) return elapsed;
		if (absolute < range.end) return elapsed + (absolute - range.start);
		elapsed += range.end - range.start;
	}
	return elapsed;
}

export function toAbsolute(kept: TimeRange[], virtual: number) {
	let remaining = Math.max(0, virtual);
	for (const range of kept) {
		const length = range.end - range.start;
		if (remaining <= length) return range.start + remaining;
		remaining -= length;
	}
	const last = kept[kept.length - 1];
	return last ? last.end : 0;
}

// Where playback should be when the playhead sits at `absolute`: the same
// spot when it is inside a kept range, the start of the next kept range when
// it is inside a hidden one, and null once nothing is left to play.
export function playablePosition(kept: TimeRange[], absolute: number) {
	for (const range of kept) {
		if (absolute < range.start) return range.start;
		if (absolute < range.end) return absolute;
	}
	return null;
}

export const overlapsKept = (
	kept: TimeRange[],
	start: number,
	end: number,
	minOverlap = 0.05,
) =>
	kept.some(
		(range) =>
			Math.min(range.end, Math.max(end, start + minOverlap)) -
				Math.max(range.start, start) >=
			minOverlap,
	);

// The ranges that are not already wholly inside one of the cuts.
export const uncoveredRanges = (ranges: TimeRange[], cuts: TimeRange[]) =>
	ranges.filter(
		(range) =>
			!cuts.some(
				(cut) => cut.start <= range.start + 0.05 && cut.end >= range.end - 0.05,
			),
	);

// The length a viewer sees. Owners are sent the full length of the file and
// everyone else the length that is left after trims and cuts.
export function shownDuration(video: {
	isOwner: boolean;
	durationSeconds: number | null;
	trimStart: number | null;
	trimEnd: number | null;
	cuts: TimeRange[];
}) {
	if (!video.isOwner || video.durationSeconds === null)
		return video.durationSeconds;
	return keptTotal(
		keptRanges(
			video.durationSeconds,
			video.trimStart,
			video.trimEnd,
			video.cuts,
		),
	);
}
