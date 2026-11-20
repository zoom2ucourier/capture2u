import { Hono } from "hono";
import type { LibraryVideo, Visibility } from "../../shared/types";
import { requireUser } from "../auth";
import {
	adminClient,
	deleteVideo,
	getVideo,
	VIDEO_COLUMNS,
	type VideoRow,
} from "../db";
import type { AppBindings, Env } from "../env";
import { hashPassword } from "../lib/password";
import { createToken } from "../lib/tokens";
import { expiryDate, isVideoId, newVideoId, positiveInt } from "../lib/util";

const LIBRARY_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const VISIBILITIES: Visibility[] = ["public", "company", "private"];

export async function toLibraryVideo(
	env: Env,
	video: VideoRow,
): Promise<LibraryVideo> {
	const retentionDays = positiveInt(env.RETENTION_DAYS, 365);
	const token = video.thumbnail_key
		? await createToken(
				env.MEDIA_TOKEN_SECRET,
				"play",
				video.id,
				LIBRARY_TOKEN_TTL_SECONDS,
			)
		: null;
	return {
		id: video.id,
		title: video.title,
		status: video.status,
		visibility: video.visibility,
		hasPassword: Boolean(video.password_hash),
		keep: video.keep,
		durationSeconds: video.duration_seconds,
		viewCount: video.view_count,
		createdAt: video.created_at,
		expiresAt: expiryDate(video.created_at, video.keep, retentionDays),
		thumbnailUrl: token
			? `/media/${video.id}/thumb.jpg?t=${encodeURIComponent(token)}`
			: null,
	};
}

export const videos = new Hono<AppBindings>();

videos.use("*", requireUser);

videos.post("/", async (c) => {
	const user = c.get("user");
	const db = adminClient(c.env);
	const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title.trim().slice(0, 200)
			: `Recording ${new Date().toISOString().slice(0, 10)}`;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const id = newVideoId();
		const { error } = await db
			.from("videos")
			.insert({ id, owner_id: user.id, title });
		if (!error)
			return c.json({
				id,
				shareUrl: `${new URL(c.req.url).origin}/v/${id}`,
			});
		if (error.code !== "23505")
			throw new Error(`Could not create video: ${error.message}`);
	}
	throw new Error("Could not allocate a video id");
});

videos.get("/", async (c) => {
	const user = c.get("user");
	const db = adminClient(c.env);
	const search = c.req.query("q")?.trim() ?? "";

	let query = db
		.from("videos")
		.select(VIDEO_COLUMNS)
		.eq("owner_id", user.id)
		.order("created_at", { ascending: false })
		.limit(300);
	if (search)
		query = query.textSearch("search", search, {
			type: "websearch",
			config: "english",
		});

	const { data, error } = await query;
	if (error) throw new Error(`Could not list videos: ${error.message}`);
	const rows = (data ?? []) as unknown as VideoRow[];
	return c.json({
		videos: await Promise.all(rows.map((row) => toLibraryVideo(c.env, row))),
	});
});

videos.patch("/:id", async (c) => {
	const user = c.get("user");
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const video = await getVideo(db, id);
	if (!video) return c.json({ error: "not_found" }, 404);
	const isOwner = video.owner_id === user.id;
	const isAdmin = user.role === "admin";
	if (!isOwner && !isAdmin) return c.json({ error: "forbidden" }, 403);

	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const update: Record<string, unknown> = {};

	if ("keep" in body) {
		if (typeof body.keep !== "boolean")
			return c.json({ error: "invalid_keep" }, 400);
		update.keep = body.keep;
	}

	if (isOwner) {
		if ("title" in body) {
			if (typeof body.title !== "string" || !body.title.trim())
				return c.json({ error: "invalid_title" }, 400);
			update.title = body.title.trim().slice(0, 200);
			update.title_edited = true;
		}
		if ("visibility" in body) {
			if (!VISIBILITIES.includes(body.visibility as Visibility))
				return c.json({ error: "invalid_visibility" }, 400);
			update.visibility = body.visibility;
		}
		if ("password" in body) {
			if (body.password === null || body.password === "") {
				update.password_hash = null;
			} else if (
				typeof body.password === "string" &&
				body.password.length >= 4 &&
				body.password.length <= 200
			) {
				update.password_hash = await hashPassword(body.password);
			} else {
				return c.json(
					{
						error: "invalid_password",
						message: "Use at least 4 characters.",
					},
					400,
				);
			}
		}
	}

	if (Object.keys(update).length === 0)
		return c.json({ error: "nothing_to_update" }, 400);

	const { data, error } = await db
		.from("videos")
		.update(update)
		.eq("id", id)
		.select(VIDEO_COLUMNS)
		.single();
	if (error) throw new Error(`Could not update video: ${error.message}`);
	return c.json({
		video: await toLibraryVideo(c.env, data as unknown as VideoRow),
	});
});

videos.delete("/:id", async (c) => {
	const user = c.get("user");
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const video = await getVideo(db, id);
	if (!video) return c.json({ error: "not_found" }, 404);
	if (video.owner_id !== user.id && user.role !== "admin")
		return c.json({ error: "forbidden" }, 403);
	await deleteVideo(c.env, db, video);
	return c.json({ deleted: true });
});
