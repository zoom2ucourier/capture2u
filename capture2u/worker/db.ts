import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
	Chapter,
	StageStatus,
	TranscriptSegment,
	VideoStatus,
	Visibility,
} from "../shared/types";
import type { Env } from "./env";
import { videoObjectPrefix } from "./lib/util";

export interface VideoRow {
	id: string;
	owner_id: string;
	title: string;
	title_edited: boolean;
	status: VideoStatus;
	visibility: Visibility;
	password_hash: string | null;
	keep: boolean;
	duration_seconds: number | null;
	width: number | null;
	height: number | null;
	size_bytes: number | null;
	mime_type: string | null;
	object_key: string | null;
	thumbnail_key: string | null;
	upload_id: string | null;
	transcript_status: StageStatus;
	transcript_text: string | null;
	transcript_segments: TranscriptSegment[] | null;
	summary: string | null;
	chapters: Chapter[] | null;
	ai_status: StageStatus;
	view_count: number;
	created_at: string;
	updated_at: string;
}

export const VIDEO_COLUMNS =
	"id,owner_id,title,title_edited,status,visibility,password_hash,keep,duration_seconds,width,height,size_bytes,mime_type,object_key,thumbnail_key,upload_id,transcript_status,transcript_text,transcript_segments,summary,chapters,ai_status,view_count,created_at,updated_at";

export const adminClient = (env: Env): SupabaseClient => {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
		throw new Error("Supabase is not configured");
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
};

export async function getVideo(db: SupabaseClient, id: string) {
	const { data, error } = await db
		.from("videos")
		.select(VIDEO_COLUMNS)
		.eq("id", id)
		.maybeSingle();
	if (error) throw new Error(`Could not load video: ${error.message}`);
	return (data as VideoRow | null) ?? null;
}

export async function deleteVideoObjects(env: Env, video: VideoRow) {
	if (video.status === "uploading" && video.upload_id && video.object_key) {
		try {
			await env.VIDEOS.resumeMultipartUpload(
				video.object_key,
				video.upload_id,
			).abort();
		} catch {
			// The upload was already completed or aborted.
		}
	}
	let cursor: string | undefined;
	do {
		const listing = await env.VIDEOS.list({
			prefix: videoObjectPrefix(video.id),
			cursor,
		});
		const keys = listing.objects.map((object) => object.key);
		if (keys.length > 0) await env.VIDEOS.delete(keys);
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
}

export async function deleteVideo(
	env: Env,
	db: SupabaseClient,
	video: VideoRow,
) {
	await deleteVideoObjects(env, video);
	const { error } = await db.from("videos").delete().eq("id", video.id);
	if (error) throw new Error(`Could not delete video: ${error.message}`);
}
