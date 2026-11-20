import type { SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import type { WatchVideo } from "../../shared/types";
import { resolveUser } from "../auth";
import { adminClient, getVideo, type VideoRow } from "../db";
import type { AppBindings, Env, SessionUser } from "../env";
import { verifyPassword } from "../lib/password";
import { createToken, sha256Hex, verifyToken } from "../lib/tokens";
import { expiryDate, isVideoId, positiveInt } from "../lib/util";

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

export const watch = new Hono<AppBindings>();

watch.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const video = await getVideo(db, id);
	if (!video) return c.json({ error: "not_found" }, 404);

	const viewer = await optionalViewer(c.env, db, c.req.header("authorization"));
	const access = checkAccess(video, viewer);
	if (!access.allowed)
		return c.json({ error: "restricted", reason: access.reason }, 403);

	if (video.password_hash && !access.isOwner) {
		const unlocked = await verifyToken(
			c.env.MEDIA_TOKEN_SECRET,
			"unlock",
			video.id,
			c.req.header("x-unlock-token"),
		);
		if (!unlocked) return c.json({ error: "password_required" }, 401);
	}

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
	const hasTranscript =
		video.transcript_status === "ready" &&
		(video.transcript_segments?.length ?? 0) > 0;

	const response: WatchVideo = {
		id: video.id,
		title: video.title,
		status: video.status,
		visibility: video.visibility,
		hasPassword: Boolean(video.password_hash),
		isOwner: access.isOwner,
		keep: access.isOwner ? video.keep : null,
		expiresAt: access.isOwner
			? expiryDate(
					video.created_at,
					video.keep,
					positiveInt(c.env.RETENTION_DAYS, 365),
				)
			: null,
		ownerName: (owner?.full_name as string | null) ?? null,
		ownerAvatarUrl: (owner?.avatar_url as string | null) ?? null,
		durationSeconds: video.duration_seconds,
		width: video.width,
		height: video.height,
		viewCount: video.view_count,
		createdAt: video.created_at,
		transcriptStatus: video.transcript_status,
		aiStatus: video.ai_status,
		summary: video.summary,
		chapters: video.chapters ?? [],
		transcript: hasTranscript ? (video.transcript_segments ?? []) : [],
		playback: token
			? {
					token,
					videoUrl: `/media/${video.id}/video${query}`,
					posterUrl: video.thumbnail_key
						? `/media/${video.id}/thumb.jpg${query}`
						: null,
					captionsUrl: hasTranscript
						? `/media/${video.id}/captions.vtt${query}`
						: null,
					downloadUrl: access.isOwner
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
	return c.json({ counted: data === true });
});
