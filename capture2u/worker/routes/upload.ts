import { Hono } from "hono";
import { requireUser } from "../auth";
import { adminClient, getVideo, type VideoRow } from "../db";
import type { AppBindings, Env, SessionUser } from "../env";
import { createToken, verifyToken } from "../lib/tokens";
import { isVideoId, videoObjectPrefix } from "../lib/util";

// These routes speak the same JSON contract as Cap's /api/upload/multipart so
// the open-source browser uploader (@cap/recorder-core) works unchanged. The
// "presigned URL" it is handed points back at this Worker, which writes the
// part into R2 through its bucket binding, so the bucket needs no public
// access, CORS rules or API keys.

const PART_TOKEN_TTL_SECONDS = 60 * 60;
const MAX_PARTS = 2000;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const SUBPATH_PATTERN = /^(?:video|raw-upload|upload)\.(mp4|webm|mov|m4v)$/;
const CONTENT_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/mp4",
};

const partSubject = (videoId: string, uploadId: string, partNumber: number) =>
	[videoId, uploadId, partNumber].join("\n");

type OwnedVideo =
	| { ok: true; video: VideoRow }
	| { ok: false; status: 400 | 403 | 404; error: string };

async function loadOwnedVideo(
	env: Env,
	user: SessionUser,
	videoId: unknown,
): Promise<OwnedVideo> {
	if (typeof videoId !== "string" || !isVideoId(videoId))
		return { ok: false, status: 400, error: "invalid_video" };
	const video = await getVideo(adminClient(env), videoId);
	if (!video) return { ok: false, status: 404, error: "not_found" };
	if (video.owner_id !== user.id)
		return { ok: false, status: 403, error: "forbidden" };
	return { ok: true, video };
}

export const upload = new Hono<AppBindings>();

upload.post("/multipart/initiate", requireUser, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const owned = await loadOwnedVideo(c.env, c.get("user"), body.videoId);
	if (!owned.ok) return c.json({ error: owned.error }, owned.status);
	const { video } = owned;
	if (video.status === "ready")
		return c.json({ error: "already_uploaded" }, 409);

	const subpath = typeof body.subpath === "string" ? body.subpath : "";
	const extension = SUBPATH_PATTERN.exec(subpath)?.[1];
	if (!extension) return c.json({ error: "invalid_subpath" }, 400);

	if (video.upload_id && video.object_key) {
		try {
			await c.env.VIDEOS.resumeMultipartUpload(
				video.object_key,
				video.upload_id,
			).abort();
		} catch {
			// Nothing to abort.
		}
	}

	const key = `${videoObjectPrefix(video.id)}${subpath}`;
	const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
	const multipart = await c.env.VIDEOS.createMultipartUpload(key, {
		httpMetadata: { contentType },
	});

	const { error } = await adminClient(c.env)
		.from("videos")
		.update({
			upload_id: multipart.uploadId,
			object_key: key,
			raw_object_key: null,
			mime_type: contentType,
			status: "uploading",
		})
		.eq("id", video.id);
	if (error) throw new Error(`Could not start upload: ${error.message}`);

	return c.json({ uploadId: multipart.uploadId, provider: "s3" });
});

upload.post("/multipart/presign-part", requireUser, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const owned = await loadOwnedVideo(c.env, c.get("user"), body.videoId);
	if (!owned.ok) return c.json({ error: owned.error }, owned.status);
	const { video } = owned;

	const partNumber = Number(body.partNumber);
	if (
		typeof body.uploadId !== "string" ||
		body.uploadId !== video.upload_id ||
		!Number.isInteger(partNumber) ||
		partNumber < 1 ||
		partNumber > MAX_PARTS
	)
		return c.json({ error: "invalid_part" }, 400);

	const token = await createToken(
		c.env.MEDIA_TOKEN_SECRET,
		"part",
		partSubject(video.id, body.uploadId, partNumber),
		PART_TOKEN_TTL_SECONDS,
	);
	const url = new URL("/api/upload/part", c.req.url);
	url.searchParams.set("video", video.id);
	url.searchParams.set("upload", body.uploadId);
	url.searchParams.set("part", String(partNumber));
	url.searchParams.set("t", token);
	return c.json({ presignedUrl: url.toString(), provider: "s3" });
});

upload.put("/part", async (c) => {
	const videoId = c.req.query("video") ?? "";
	const uploadId = c.req.query("upload") ?? "";
	const partNumber = Number(c.req.query("part"));
	const valid =
		isVideoId(videoId) &&
		uploadId !== "" &&
		Number.isInteger(partNumber) &&
		(await verifyToken(
			c.env.MEDIA_TOKEN_SECRET,
			"part",
			partSubject(videoId, uploadId, partNumber),
			c.req.query("t"),
		));
	if (!valid) return c.json({ error: "forbidden" }, 403);

	const video = await getVideo(adminClient(c.env), videoId);
	if (!video?.object_key || video.upload_id !== uploadId)
		return c.json({ error: "upload_not_found" }, 404);
	const body = c.req.raw.body;
	if (!body) return c.json({ error: "empty_part" }, 400);

	const part = await c.env.VIDEOS.resumeMultipartUpload(
		video.object_key,
		uploadId,
	).uploadPart(partNumber, body);
	return new Response(null, {
		status: 200,
		headers: { ETag: `"${part.etag}"` },
	});
});

upload.post("/multipart/complete", requireUser, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const owned = await loadOwnedVideo(c.env, c.get("user"), body.videoId);
	if (!owned.ok) return c.json({ error: owned.error }, owned.status);
	const { video } = owned;

	// A retried completion after a lost response must succeed, not fail.
	if (video.status === "ready")
		return c.json({ success: true, processingStarted: true });

	if (
		typeof body.uploadId !== "string" ||
		body.uploadId !== video.upload_id ||
		!video.object_key
	)
		return c.json({ error: "upload_not_found" }, 400);

	const parts: R2UploadedPart[] = [];
	if (Array.isArray(body.parts)) {
		for (const entry of body.parts) {
			const item = entry as Record<string, unknown> | null;
			const partNumber = Number(item?.partNumber);
			if (
				!Number.isInteger(partNumber) ||
				partNumber < 1 ||
				typeof item?.etag !== "string" ||
				!item.etag
			)
				return c.json({ error: "invalid_parts" }, 400);
			parts.push({ partNumber, etag: item.etag });
		}
	}
	if (parts.length === 0 || parts.length > MAX_PARTS)
		return c.json({ error: "invalid_parts" }, 400);
	parts.sort((left, right) => left.partNumber - right.partNumber);

	const object = await c.env.VIDEOS.resumeMultipartUpload(
		video.object_key,
		body.uploadId,
	).complete(parts);

	const numberOrNull = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: null;
	const width = numberOrNull(body.width);
	const height = numberOrNull(body.height);
	const needsSeekableCopy =
		video.object_key.endsWith(".mp4") && body.seekable !== true;

	const { error } = await adminClient(c.env)
		.from("videos")
		.update({
			status: "ready",
			upload_id: null,
			size_bytes: object.size,
			duration_seconds: numberOrNull(body.durationInSecs),
			width: width === null ? null : Math.round(width),
			height: height === null ? null : Math.round(height),
			optimized: !needsSeekableCopy,
			transcript_status: "pending",
			ai_status: "pending",
		})
		.eq("id", video.id);
	if (error) throw new Error(`Could not finish upload: ${error.message}`);

	let processingStarted = true;
	try {
		const origin = new URL(c.req.url).origin;
		if (needsSeekableCopy)
			await c.env.JOBS.send({
				type: "optimize-video",
				videoId: video.id,
				origin,
			});
		await c.env.JOBS.send({ type: "process-video", videoId: video.id, origin });
	} catch (queueError) {
		processingStarted = false;
		console.error("Could not queue processing", queueError);
	}
	return c.json({ success: true, processingStarted });
});

upload.post("/multipart/abort", requireUser, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const owned = await loadOwnedVideo(c.env, c.get("user"), body.videoId);
	if (!owned.ok) return c.json({ error: owned.error }, owned.status);
	const { video } = owned;
	if (
		video.status !== "ready" &&
		video.object_key &&
		typeof body.uploadId === "string" &&
		body.uploadId === video.upload_id
	) {
		try {
			await c.env.VIDEOS.resumeMultipartUpload(
				video.object_key,
				body.uploadId,
			).abort();
		} catch {
			// Already gone.
		}
		await adminClient(c.env)
			.from("videos")
			.update({ upload_id: null, status: "failed" })
			.eq("id", video.id);
	}
	return c.json({ success: true });
});

upload.put("/thumbnail/:id", requireUser, async (c) => {
	const owned = await loadOwnedVideo(c.env, c.get("user"), c.req.param("id"));
	if (!owned.ok) return c.json({ error: owned.error }, owned.status);
	const bytes = await c.req.arrayBuffer();
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES)
		return c.json({ error: "invalid_thumbnail" }, 400);
	const view = new Uint8Array(bytes);
	if (view[0] !== 0xff || view[1] !== 0xd8)
		return c.json({ error: "invalid_thumbnail" }, 400);

	const key = `${videoObjectPrefix(owned.video.id)}thumb.jpg`;
	await c.env.VIDEOS.put(key, bytes, {
		httpMetadata: { contentType: "image/jpeg" },
	});
	const { error } = await adminClient(c.env)
		.from("videos")
		.update({ thumbnail_key: key })
		.eq("id", owned.video.id);
	if (error) throw new Error(`Could not save thumbnail: ${error.message}`);
	return c.json({ success: true });
});
