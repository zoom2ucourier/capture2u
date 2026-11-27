import { Hono } from "hono";
import { EXTENSION_KEY_PREFIX, hashExtensionKey, requireUser } from "../auth";
import { adminClient, createVideoRow, deleteVideo, getVideo } from "../db";
import type { AppBindings } from "../env";
import { isVideoId } from "../lib/util";
import { parsePageLinks } from "../../shared/pageLinks";

// The browser extension is Cap's open-source recorder pointed at this Worker,
// so these routes keep the paths and JSON shapes it already speaks.

const MAX_KEYS_PER_USER = 10;
const REDIRECT_PATTERN = /^https:\/\/([a-p]{32})\.chromiumapp\.org(\/[^#]*)?$/;

export const parseExtensionIds = (list: string) =>
	list
		.split(",")
		.map((id) => id.trim().toLowerCase())
		.filter((id) => /^[a-p]{32}$/.test(id));

// A sign-in key is only ever handed to the Capture2u extension itself. Any
// other extension that opens the consent page is turned away, so it cannot
// borrow the page to get a key for the person looking at it.
export function isExtensionRedirect(
	value: unknown,
	allowedIds: string[],
): value is string {
	if (typeof value !== "string" || value.length > 300) return false;
	const id = REDIRECT_PATTERN.exec(value)?.[1];
	return id !== undefined && allowedIds.includes(id);
}

export const isAuthState = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function newExtensionKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return (
		EXTENSION_KEY_PREFIX +
		Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
	);
}

export const extension = new Hono<AppBindings>();

extension.get("/auth/start", (c) => {
	const redirectUri = c.req.query("redirectUri");
	const state = c.req.query("state") ?? "";
	if (
		!isExtensionRedirect(redirectUri, parseExtensionIds(c.env.EXTENSION_IDS)) ||
		(state && !isAuthState(state))
	)
		return c.json({ error: "invalid_request" }, 400);
	const target = new URL("/extension/connect", c.req.url);
	target.searchParams.set("redirectUri", redirectUri);
	if (state) target.searchParams.set("state", state);
	return c.redirect(target.toString(), 302);
});

extension.post("/auth/approve", requireUser, async (c) => {
	const user = c.get("user");
	if (user.extensionKeyId) return c.json({ error: "forbidden" }, 403);
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const state = body.state ?? "";
	if (
		!isExtensionRedirect(
			body.redirectUri,
			parseExtensionIds(c.env.EXTENSION_IDS),
		) ||
		(state && !isAuthState(state))
	)
		return c.json({ error: "invalid_request" }, 400);

	const db = adminClient(c.env);
	const key = newExtensionKey();
	const { error } = await db
		.from("extension_keys")
		.insert({ user_id: user.id, key_hash: await hashExtensionKey(key) });
	if (error) throw new Error(`Could not connect extension: ${error.message}`);

	const { data: existing } = await db
		.from("extension_keys")
		.select("id")
		.eq("user_id", user.id)
		.order("created_at", { ascending: false })
		.range(MAX_KEYS_PER_USER, MAX_KEYS_PER_USER + 50);
	const stale = (existing ?? []).map((row) => row.id as string);
	if (stale.length > 0)
		await db.from("extension_keys").delete().in("id", stale);

	const fragment = new URLSearchParams();
	if (state) fragment.set("state", state as string);
	fragment.set("authApiKey", key);
	fragment.set("userId", user.id);
	return c.json({ redirectUrl: `${body.redirectUri}#${fragment.toString()}` });
});

extension.post("/auth/revoke", requireUser, async (c) => {
	const user = c.get("user");
	if (user.extensionKeyId)
		await adminClient(c.env)
			.from("extension_keys")
			.delete()
			.eq("id", user.extensionKeyId);
	return c.json({ success: true });
});

extension.get("/bootstrap", requireUser, (c) => {
	const user = c.get("user");
	return c.json({
		user: { id: user.id, email: user.email },
		organization: { id: "locate2u", name: "Locate2u" },
		plan: { isPro: true, maxRecordingSeconds: null },
	});
});

extension.post("/instant-recordings", requireUser, async (c) => {
	const created = await createVideoRow(
		adminClient(c.env),
		c.get("user").id,
		null,
		"extension",
	);
	return c.json({
		id: created.id,
		shareUrl: `${c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin}/v/${created.id}`,
		upload: { type: "put", url: "", headers: {} },
	});
});

extension.post("/instant-recordings/progress", requireUser, (c) =>
	c.json({ success: true }),
);

extension.post(
	"/instant-recordings/:videoId/pages",
	requireUser,
	async (c) => {
		const id = c.req.param("videoId");
		if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
		const body = (await c.req.json().catch(() => null)) as {
			pages?: unknown;
		} | null;
		const pages = parsePageLinks(body?.pages);
		if (!pages) return c.json({ error: "invalid_pages" }, 400);
		const db = adminClient(c.env);
		const video = await getVideo(db, id);
		if (!video) return c.json({ error: "not_found" }, 404);
		if (video.owner_id !== c.get("user").id)
			return c.json({ error: "forbidden" }, 403);
		const { error } = await db
			.from("videos")
			.update({ page_links: pages.length > 0 ? pages : null })
			.eq("id", id);
		if (error) throw new Error(`Could not save pages: ${error.message}`);
		return c.json({ success: true });
	},
);

extension.delete("/instant-recordings/:videoId", requireUser, async (c) => {
	const id = c.req.param("videoId");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const video = await getVideo(db, id);
	if (!video) return c.json({ success: true });
	if (video.owner_id !== c.get("user").id)
		return c.json({ error: "forbidden" }, 403);
	await deleteVideo(c.env, db, video);
	return c.json({ success: true });
});
