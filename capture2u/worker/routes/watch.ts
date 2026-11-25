import type { SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import type { WatchVideo } from "../../shared/types";
import { resolveUser } from "../auth";
import { adminClient, getVideo, type VideoRow, videoTrim } from "../db";
import type { AppBindings, Env, SessionUser } from "../env";
import { notifyFirstView } from "../lib/notify";
import { verifyPassword } from "../lib/password";
import { createToken, sha256Hex, verifyToken } from "../lib/tokens";
import {
	expiryDate,
	isVideoId,
	positiveInt,
	trimmedDuration,
	withinTrim,
} from "../lib/util";

const PLAY_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const UNLOCK_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type Access =
	| { allowed: true; isOwner: boolean }
	| { allowed: false; reason: "sign_in" | "private" };

export function checkAccess(
	video: Pick<VideoRow, "owner_id" | "visibility">,
	viewer: SessionUser | null,
): Access {
	const isOwner = viewer !== null && viewer.id === video.owner_id;
	if (isOwner || viewer?.role === "admin") return { allowed: true, isOwner };
	if (video.visibility === "public") return { allowed: true, isOwner: false };
	if (video.visibility === "company")
		return viewer
			? { allowed: true, isOwner: false }
			: { allowed: false, reason: "sign_in" };
	return { allowed: false, reason: viewer ? "private" : "sign_in" };
}

async function optionalViewer(
	env: Env,
	db: SupabaseClient,
	authorization: string | undefined,
) {
	if (!authorization) return null;
	const result = await resolveUser(env, db, authorization);
	return result.ok ? result.user : null;
}

export type Watchable =
	| {
			ok: true;
			db: SupabaseClient;
			video: VideoRow;
			viewer: SessionUser | null;
			isOwner: boolean;
	  }
	| {
			ok: false;
			status: 401 | 403 | 404;
			body: { error: string; reason?: string };
	  };

export async function loadWatchable(
	env: Env,
	id: string,
	headers: { authorization?: string; unlockToken?: string },
): Promise<Watchable> {
	if (!isVideoId(id))
		return { ok: false, status: 404, body: { error: "not_found" } };
	const db = adminClient(env);
	const video = await getVideo(db, id);
	if (!video) return { ok: false, status: 404, body: { error: "not_found" } };

	const viewer = await optionalViewer(env, db, headers.authorization);
	const access = checkAccess(video, viewer);
	if (!access.allowed)
		return {
			ok: false,
			status: 403,
			body: { error: "restricted", reason: access.reason },
		};

	if (video.password_hash && !access.isOwner) {
		const unlocked = await verifyToken(
			env.MEDIA_TOKEN_SECRET,
			"unlock",
			video.id,
			headers.unlockToken,
		);
		if (!unlocked)
			return { ok: false, status: 401, body: { error: "password_required" } };
	}
	return { ok: true, db, video, viewer, isOwner: access.isOwner };
}

export const watch = new Hono<AppBindings>();

watch.get("/:id", async (c) => {
	const loaded = await loadWatchable(c.env, c.req.param("id"), {
		authorization: c.req.header("authorization"),
		unlockToken: c.req.header("x-unlock-token"),
	});
	if (!loaded.ok) return c.json(loaded.body, loaded.status);
	const { db, video, isOwner } = loaded;

	const { data: owner } = await db
		.from("profiles")
		.select("full_name,avatar_url")
		.eq("id", video.owner_id)
		.maybeSingle();

	const ready = video.status === "ready" && Boolean(video.object_key);
	const token = ready
		? await createToken(
				c.env.MEDIA_TOKEN_SECRET,
				"play",
				video.id,
				PLAY_TOKEN_TTL_SECONDS,
			)
		: null;
	const query = token ? `?t=${encodeURIComponent(token)}` : "";
	const trim = videoTrim(video);
	const transcript =
		video.transcript_status === "ready"
			? withinTrim(video.transcript_segments ?? [], trim)
			: [];

	const response: WatchVideo = {
		id: video.id,
		title: video.title,
		status: video.status,
		visibility: video.visibility,
		hasPassword: Boolean(video.password_hash),
		isOwner,
		keep: isOwner ? video.keep : null,
		expiresAt: isOwner
			? expiryDate(
					video.created_at,
					video.keep,
					positiveInt(c.env.RETENTION_DAYS, 365),
				)
			: null,
		ownerName: (owner?.full_name as string | null) ?? null,
		ownerAvatarUrl: (owner?.avatar_url as string | null) ?? null,
		durationSeconds: isOwner
			? video.duration_seconds
			: trimmedDuration(video.duration_seconds, trim),
		trimStart: trim.start,
		trimEnd: trim.end,
		width: video.width,
		height: video.height,
		viewCount: video.view_count,
		createdAt: video.created_at,
		transcriptStatus: video.transcript_status,
		aiStatus: video.ai_status,
		summary: video.summary,
		chapters: withinTrim(video.chapters ?? [], trim),
		transcript,
		playback: token
			? {
					token,
					videoUrl: `/media/${video.id}/video${query}`,
					posterUrl: video.thumbnail_key
						? `/media/${video.id}/thumb.jpg${query}`
						: null,
					captionsUrl:
						transcript.length > 0
							? `/media/${video.id}/captions.vtt${query}`
							: null,
					downloadUrl: isOwner
						? `/media/${video.id}/video${query}&download=1`
						: null,
				}
			: null,
	};
	return c.json(response, 200, { "Cache-Control": "private, no-store" });
});

watch.post("/:id/unlock", async (c) => {
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const video = await getVideo(adminClient(c.env), id);
	if (!video?.password_hash) return c.json({ error: "not_found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as {
		password?: unknown;
	};
	if (
		typeof body.password !== "string" ||
		!(await verifyPassword(body.password, video.password_hash))
	)
		return c.json({ error: "wrong_password" }, 401);
	return c.json({
		unlockToken: await createToken(
			c.env.MEDIA_TOKEN_SECRET,
			"unlock",
			video.id,
			UNLOCK_TOKEN_TTL_SECONDS,
		),
	});
});

watch.post("/:id/view", async (c) => {
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
	const valid = await verifyToken(
		c.env.MEDIA_TOKEN_SECRET,
		"play",
		id,
		typeof body.token === "string" ? body.token : null,
	);
	if (!valid) return c.json({ error: "forbidden" }, 403);

	const db = adminClient(c.env);
	const viewer = await optionalViewer(c.env, db, c.req.header("authorization"));
	const video = await getVideo(db, id);
	if (!video) return c.json({ error: "not_found" }, 404);
	if (viewer?.id === video.owner_id) return c.json({ counted: false });

	const viewerKey = viewer
		? `user:${viewer.id}`
		: `anon:${await sha256Hex(
				[
					c.req.header("cf-connecting-ip") ?? "",
					c.req.header("user-agent") ?? "",
					id,
				].join("|"),
			)}`;
	const { data, error } = await db.rpc("record_video_view", {
		p_video_id: id,
		p_viewer_key: viewerKey,
		p_viewer_id: viewer?.id ?? null,
	});
	if (error) throw new Error(`Could not record view: ${error.message}`);

	if (data === true && video.first_view_notified_at === null)
		c.executionCtx.waitUntil(
			notifyFirstView(c.env, db, video, viewer).catch((cause) =>
				console.error("[capture2u] first view email", cause),
			),
		);
	return c.json({ counted: data === true });
});
