import type { SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import type { VideoViewers, WatchVideo } from "../../shared/types";
import { resolveUser } from "../auth";
import {
	adminClient,
	getVideo,
	type VideoRow,
	videoKept,
	videoTrim,
} from "../db";
import type { AppBindings, Env, SessionUser } from "../env";
import { verifyPassword } from "../lib/password";
import { escapeSlack, sendSlackAlerts, slackLink } from "../lib/slack";
import { createToken, sha256Hex, verifyToken } from "../lib/tokens";
import {
	displayName,
	expiryDate,
	isVideoId,
	positiveInt,
	visibleChapters,
	visibleDuration,
	visibleSegments,
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

const MAX_VIEW_ROWS = 2000;

async function loadViewers(
	db: SupabaseClient,
	videoId: string,
): Promise<VideoViewers> {
	const { data, error } = await db
		.from("video_views")
		.select("viewer_key,viewer_id,created_at")
		.eq("video_id", videoId)
		.order("created_at", { ascending: false })
		.limit(MAX_VIEW_ROWS);
	if (error) throw new Error(`Could not load viewers: ${error.message}`);

	const people = new Map<string, { views: number; lastViewedAt: string }>();
	const anonymous = new Set<string>();
	for (const row of data ?? []) {
		const viewerId = row.viewer_id as string | null;
		if (!viewerId) {
			anonymous.add(row.viewer_key as string);
			continue;
		}
		const seen = people.get(viewerId);
		if (seen) seen.views += 1;
		else
			people.set(viewerId, {
				views: 1,
				lastViewedAt: row.created_at as string,
			});
	}

	const names = new Map<string, string>();
	if (people.size > 0) {
		const { data: profiles, error: profileError } = await db
			.from("profiles")
			.select("id,full_name,email")
			.in("id", [...people.keys()]);
		if (profileError)
			throw new Error(`Could not load viewers: ${profileError.message}`);
		for (const profile of profiles ?? [])
			names.set(
				profile.id as string,
				displayName(
					profile.full_name as string | null,
					profile.email as string | null,
				),
			);
	}

	return {
		people: [...people].map(([id, seen]) => ({
			name: names.get(id) ?? "Unknown",
			views: seen.views,
			lastViewedAt: seen.lastViewedAt,
		})),
		anonymous: anonymous.size,
	};
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
		.select("full_name,email,avatar_url")
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
	const cuts = video.cuts ?? [];
	const kept = videoKept(video);
	const transcript =
		video.transcript_status === "ready"
			? visibleSegments(video.transcript_segments ?? [], kept)
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
		ownerName: owner
			? displayName(
					owner.full_name as string | null,
					owner.email as string | null,
				)
			: null,
		ownerAvatarUrl: (owner?.avatar_url as string | null) ?? null,
		durationSeconds: isOwner
			? video.duration_seconds
			: visibleDuration(video.duration_seconds, trim, cuts),
		trimStart: trim.start,
		trimEnd: trim.end,
		cuts,
		suggestedCuts: isOwner ? video.suggested_cuts : null,
		optimized: video.optimized,
		width: video.width,
		height: video.height,
		viewCount: video.view_count,
		viewers: isOwner ? await loadViewers(db, video.id) : null,
		createdAt: video.created_at,
		transcriptStatus: video.transcript_status,
		aiStatus: video.ai_status,
		summary: video.summary,
		chapters: visibleChapters(video.chapters ?? [], kept),
		transcript,
		playback: token
			? {
					token,
					videoUrl: `/media/${video.id}/video${query}&f=${video.optimized ? "s" : "r"}`,
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
	if (data === true)
		c.executionCtx.waitUntil(
			alertOwnerOfView(c.env, db, video, viewer, viewerKey).catch((cause) =>
				console.error("[capture2u] view alert", cause),
			),
		);
	return c.json({ counted: data === true });
});

// Staff are announced the first time each of them watches. Viewers who are
// not signed in cannot be told apart reliably, so only the first one is.
async function alertOwnerOfView(
	env: Env,
	db: SupabaseClient,
	video: VideoRow,
	viewer: SessionUser | null,
	viewerKey: string,
) {
	const link = slackLink(`${env.PUBLIC_BASE_URL}/v/${video.id}`, video.title);
	if (viewer) {
		const { count } = await db
			.from("video_views")
			.select("video_id", { count: "exact", head: true })
			.eq("video_id", video.id)
			.eq("viewer_key", viewerKey);
		if ((count ?? 0) > 1) return;
		const name = escapeSlack(displayName(viewer.fullName, viewer.email));
		await sendSlackAlerts(
			env,
			db,
			[video.owner_id],
			`:eyes: *${name}* watched ${link}`,
		);
		return;
	}
	if (video.first_view_notified_at) return;
	const { data } = await db
		.from("videos")
		.update({ first_view_notified_at: new Date().toISOString() })
		.eq("id", video.id)
		.is("first_view_notified_at", null)
		.select("id");
	if (!data || data.length === 0) return;
	await sendSlackAlerts(
		env,
		db,
		[video.owner_id],
		`:eyes: Someone who was not signed in watched ${link}`,
	);
}
