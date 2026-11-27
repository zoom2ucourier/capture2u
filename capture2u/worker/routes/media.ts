import { Hono } from "hono";
import { adminClient, getVideo, isOpenVideo, videoKept } from "../db";
import type { AppBindings } from "../env";
import { verifyToken } from "../lib/tokens";
import { segmentsToVtt } from "../lib/transcript";
import { isVideoId, parseRangeHeader, visibleSegments } from "../lib/util";

export const media = new Hono<AppBindings>();

const hasPlayToken = (
	secret: string,
	videoId: string,
	token: string | undefined,
) => verifyToken(secret, "play", videoId, token);

media.on(["GET", "HEAD"], "/:id/video", async (c) => {
	const id = c.req.param("id");
	if (
		!isVideoId(id) ||
		!(await hasPlayToken(c.env.MEDIA_TOKEN_SECRET, id, c.req.query("t")))
	)
		return c.json({ error: "forbidden" }, 403);

	const video = await getVideo(adminClient(c.env), id);
	if (!video?.object_key || video.status !== "ready")
		return c.json({ error: "not_found" }, 404);

	// A viewer who started on the first upload keeps reading that same file
	// after the seekable copy replaces it, because the two differ byte for byte.
	const wantsFirstUpload = c.req.query("f") === "r" && video.raw_object_key;
	let objectKey = wantsFirstUpload ? video.raw_object_key : video.object_key;
	let head = objectKey ? await c.env.VIDEOS.head(objectKey) : null;
	if (!head && wantsFirstUpload) {
		objectKey = video.object_key;
		head = await c.env.VIDEOS.head(objectKey);
	}
	if (!head || !objectKey) return c.json({ error: "not_found" }, 404);

	const headers = new Headers({
		"Content-Type":
			head.httpMetadata?.contentType ?? video.mime_type ?? "video/mp4",
		"Accept-Ranges": "bytes",
		ETag: head.httpEtag,
		"Cache-Control": "private, max-age=3600",
	});
	if (c.req.query("download") === "1") {
		const extension = /\.(webm|mov|m4v)$/.exec(objectKey)?.[1] ?? "mp4";
		const safeTitle =
			video.title
				.replace(/[^\w\- ]+/g, "")
				.trim()
				.slice(0, 80) || "recording";
		headers.set(
			"Content-Disposition",
			`attachment; filename="${safeTitle}.${extension}"`,
		);
	}

	const range = parseRangeHeader(c.req.header("range") ?? null, head.size);
	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${head.size}`);
		return new Response(null, { status: 416, headers });
	}

	if (c.req.method === "HEAD") {
		headers.set("Content-Length", String(head.size));
		return new Response(null, { status: 200, headers });
	}

	const object = await c.env.VIDEOS.get(
		objectKey,
		range ? { range } : undefined,
	);
	if (!object) return c.json({ error: "not_found" }, 404);

	if (range) {
		headers.set(
			"Content-Range",
			`bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
		);
		headers.set("Content-Length", String(range.length));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(head.size));
	return new Response(object.body, { status: 200, headers });
});

// Thumbnails for open videos are readable without a token so link previews in
// Slack and elsewhere can show them. Anything locked needs a play token.
media.get("/:id/thumb.jpg", async (c) => {
	const id = c.req.param("id");
	if (!isVideoId(id)) return c.json({ error: "not_found" }, 404);
	const video = await getVideo(adminClient(c.env), id);
	if (!video?.thumbnail_key) return c.json({ error: "not_found" }, 404);

	const isOpen = isOpenVideo(video);
	if (
		!isOpen &&
		!(await hasPlayToken(c.env.MEDIA_TOKEN_SECRET, id, c.req.query("t")))
	)
		return c.json({ error: "forbidden" }, 403);

	const object = await c.env.VIDEOS.get(video.thumbnail_key);
	if (!object) return c.json({ error: "not_found" }, 404);
	return new Response(object.body, {
		headers: {
			"Content-Type": "image/jpeg",
			"Cache-Control": isOpen ? "public, max-age=300" : "private, max-age=300",
		},
	});
});

media.get("/:id/captions.vtt", async (c) => {
	const id = c.req.param("id");
	if (
		!isVideoId(id) ||
		!(await hasPlayToken(c.env.MEDIA_TOKEN_SECRET, id, c.req.query("t")))
	)
		return c.json({ error: "forbidden" }, 403);
	const video = await getVideo(adminClient(c.env), id);
	const segments = video
		? visibleSegments(video.transcript_segments ?? [], videoKept(video))
		: [];
	if (segments.length === 0) return c.json({ error: "not_found" }, 404);
	return new Response(segmentsToVtt(segments), {
		headers: {
			"Content-Type": "text/vtt; charset=utf-8",
			"Cache-Control": "private, max-age=300",
		},
	});
});
