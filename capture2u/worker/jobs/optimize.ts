import { adminClient, getVideo } from "../db";
import type { Env } from "../env";
import { videoObjectPrefix } from "../lib/util";

const MAX_OPTIMIZE_BYTES = 4 * 1024 * 1024 * 1024;
const FIRST_UPLOAD_GRACE_HOURS = 6;
const MAX_CLEANED_PER_RUN = 500;

export const seekableObjectKey = (videoId: string) =>
	`${videoObjectPrefix(videoId)}video-seekable.mp4`;

// Recordings are uploaded while they are still being made, so what lands in
// storage first has no seek index. This writes a seekable copy beside it and
// points the video at the copy. The first upload stays for a few hours so
// anyone already watching it is not cut off.
export async function optimizeVideo(env: Env, videoId: string) {
	const db = adminClient(env);
	const video = await getVideo(db, videoId);
	if (
		!video ||
		video.status !== "ready" ||
		video.optimized ||
		!video.object_key
	)
		return;

	const sourceKey = video.object_key;
	const head = await env.VIDEOS.head(sourceKey);
	if (!head) return;
	if (!sourceKey.endsWith(".mp4") || head.size > MAX_OPTIMIZE_BYTES) {
		await db.from("videos").update({ optimized: true }).eq("id", videoId);
		return;
	}

	// Loaded only here so the media library is not parsed on every request.
	const { remuxToSeekableMp4 } = await import("../lib/remux");
	const targetKey = seekableObjectKey(videoId);
	const upload = await env.VIDEOS.createMultipartUpload(targetKey, {
		httpMetadata: { contentType: "video/mp4" },
	});
	const parts: R2UploadedPart[] = [];
	try {
		const result = await remuxToSeekableMp4({
			size: head.size,
			read: async (offset, length) => {
				const object = await env.VIDEOS.get(sourceKey, {
					range: { offset, length },
				});
				if (!object) throw new Error("Stored file is missing");
				return new Uint8Array(await object.arrayBuffer());
			},
			writePart: async (partNumber, bytes) => {
				parts.push(await upload.uploadPart(partNumber, bytes));
			},
		});
		parts.sort((left, right) => left.partNumber - right.partNumber);
		const object = await upload.complete(parts);

		const { data, error } = await db
			.from("videos")
			.update({
				object_key: targetKey,
				raw_object_key: sourceKey,
				optimized: true,
				size_bytes: object.size,
				mime_type: "video/mp4",
				...(video.duration_seconds === null && result.durationSeconds !== null
					? { duration_seconds: result.durationSeconds }
					: {}),
			})
			.eq("id", videoId)
			.eq("object_key", sourceKey)
			.select("id");
		if (error)
			throw new Error(`Could not save seekable copy: ${error.message}`);
		if (!data || data.length === 0) await env.VIDEOS.delete(targetKey);
	} catch (cause) {
		await upload.abort().catch(() => undefined);
		throw cause;
	}
}

export async function cleanFirstUploads(env: Env, now: Date = new Date()) {
	const db = adminClient(env);
	const cutoff = new Date(
		now.getTime() - FIRST_UPLOAD_GRACE_HOURS * 3_600_000,
	).toISOString();
	const { data, error } = await db
		.from("videos")
		.select("id,object_key,raw_object_key")
		.not("raw_object_key", "is", null)
		.lt("updated_at", cutoff)
		.limit(MAX_CLEANED_PER_RUN);
	if (error) throw new Error(`First-upload query failed: ${error.message}`);
	for (const row of data ?? []) {
		const rawKey = row.raw_object_key as string;
		if (rawKey !== row.object_key) await env.VIDEOS.delete(rawKey);
		await db.from("videos").update({ raw_object_key: null }).eq("id", row.id);
	}
}
