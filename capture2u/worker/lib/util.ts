const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function newVideoId(length = 12) {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let id = "";
	for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
	return id;
}

export const isVideoId = (value: string) => /^[a-z0-9]{8,24}$/.test(value);

export function parseAllowedDomains(list: string | undefined) {
	return (list ?? "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

export function isAllowedEmail(
	email: string | undefined | null,
	domains: string[],
) {
	if (!email) return false;
	const at = email.lastIndexOf("@");
	if (at <= 0) return false;
	return domains.includes(email.slice(at + 1).toLowerCase());
}

export function positiveInt(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ByteRange {
	offset: number;
	length: number;
}

// Single-range requests only, which is all browsers send for media.
export function parseRangeHeader(
	header: string | null,
	size: number,
): ByteRange | null | "invalid" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return "invalid";
	const startText = match[1] ?? "";
	const endText = match[2] ?? "";
	if (startText === "" && endText === "") return "invalid";
	if (startText === "") {
		const suffix = Number(endText);
		if (suffix <= 0) return "invalid";
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const start = Number(startText);
	if (start >= size) return "invalid";
	const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
	if (end < start) return "invalid";
	return { offset: start, length: end - start + 1 };
}

export const videoObjectPrefix = (videoId: string) => `videos/${videoId}/`;

export function expiryDate(
	createdAt: string,
	keep: boolean,
	retentionDays: number,
) {
	if (keep) return null;
	return new Date(
		new Date(createdAt).getTime() + retentionDays * 86_400_000,
	).toISOString();
}

export const isUuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export interface Trim {
	start: number | null;
	end: number | null;
}

const MIN_TRIMMED_SECONDS = 1;

const trimValue = (value: unknown) => {
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return "invalid" as const;
	return Math.round(value * 10) / 10;
};

export function normalizeTrim(
	startInput: unknown,
	endInput: unknown,
	durationSeconds: number | null,
): Trim | "invalid" {
	let start = trimValue(startInput);
	let end = trimValue(endInput);
	if (start === "invalid" || end === "invalid") return "invalid";
	if (start === 0) start = null;
	if (durationSeconds !== null && durationSeconds > 0) {
		if (start !== null && start >= durationSeconds) return "invalid";
		if (end !== null && end >= durationSeconds) end = null;
	}
	if (end !== null && end - (start ?? 0) < MIN_TRIMMED_SECONDS)
		return "invalid";
	if (
		start !== null &&
		end === null &&
		durationSeconds !== null &&
		durationSeconds - start < MIN_TRIMMED_SECONDS
	)
		return "invalid";
	return { start, end };
}

export function withinTrim<T extends { start: number; end?: number }>(
	items: T[],
	trim: Trim,
) {
	if (trim.start === null && trim.end === null) return items;
	const from = trim.start ?? 0;
	const to = trim.end ?? Number.POSITIVE_INFINITY;
	return items.filter(
		(item) => (item.end ?? item.start) >= from && item.start < to,
	);
}

export function trimmedDuration(durationSeconds: number | null, trim: Trim) {
	if (durationSeconds === null) return null;
	const end = Math.min(trim.end ?? durationSeconds, durationSeconds);
	return Math.max(0, end - (trim.start ?? 0));
}

export const nameFromEmail = (email: string) =>
	(email.split("@")[0] ?? "")
		.split(/[._-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");

export const displayName = (
	fullName: string | null | undefined,
	email: string | null | undefined,
) => fullName?.trim() || (email ? nameFromEmail(email) : "") || "Someone";

export const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

export const embedHtml = (baseUrl: string, id: string, title: string) =>
	`<iframe src="${escapeHtml(`${baseUrl}/embed/${id}`)}" title="${escapeHtml(title)}" width="640" height="360" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
