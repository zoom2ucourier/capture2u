import type { PageLink } from "./types";

export const MAX_PAGE_LINKS = 100;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;

const webUrl = (value: unknown) => {
	if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
};

export function parsePageLinks(value: unknown): PageLink[] | null {
	if (!Array.isArray(value) || value.length > MAX_PAGE_LINKS) return null;
	const links: PageLink[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return null;
		const item = entry as Record<string, unknown>;
		const url = webUrl(item.url);
		const at = item.at;
		if (!url || typeof at !== "number" || !Number.isFinite(at) || at < 0)
			return null;
		const title =
			typeof item.title === "string" && item.title.trim()
				? item.title.trim().slice(0, MAX_TITLE_LENGTH)
				: null;
		links.push({ url, title, at });
	}
	return links.sort((left, right) => left.at - right.at);
}

export function pageLinkAt(links: PageLink[], seconds: number) {
	let current: PageLink | null = null;
	for (const link of links) {
		if (link.at > seconds) break;
		current = link;
	}
	return current ?? links[0] ?? null;
}

export function shortPageLabel(url: string) {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return `${parsed.hostname.replace(/^www\./, "")}${path}`;
	} catch {
		return url;
	}
}
