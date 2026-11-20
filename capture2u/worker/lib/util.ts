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
