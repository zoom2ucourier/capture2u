import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
	Chapter,
	PageLink,
	StageStatus,
	SuggestedCuts,
	TimeRange,
	TranscriptSegment,
	VideoSource,
	VideoStatus,
	Visibility,
} from "../shared/types";
import type { Env } from "./env";
import {
	displayName,
	newVideoId,
	videoObjectPrefix,
	visibleRanges,
} from "./lib/util";

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
	folder_id: string | null;
	trim_start_seconds: number | null;
	trim_end_seconds: number | null;
	cuts: TimeRange[] | null;
	suggested_cuts: SuggestedCuts | null;
	optimized: boolean;
	raw_object_key: string | null;
	source: VideoSource;
	page_links: PageLink[] | null;
	first_view_notified_at: string | null;
	created_at: string;
	updated_at: string;
}

export const VIDEO_COLUMNS =
	"id,owner_id,title,title_edited,status,visibility,password_hash,keep,duration_seconds,width,height,size_bytes,mime_type,object_key,thumbnail_key,upload_id,transcript_status,transcript_text,transcript_segments,summary,chapters,ai_status,view_count,folder_id,trim_start_seconds,trim_end_seconds,cuts,suggested_cuts,optimized,raw_object_key,source,page_links,first_view_notified_at,created_at,updated_at";

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

export async function createVideoRow(
	db: SupabaseClient,
	ownerId: string,
	title: string | null,
	source: VideoSource,
) {
	const row = {
		owner_id: ownerId,
		title: title ?? `Recording ${new Date().toISOString().slice(0, 10)}`,
		source,
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const id = newVideoId();
		const { error } = await db.from("videos").insert({ id, ...row });
		if (!error) return { id };
		if (error.code !== "23505")
			throw new Error(`Could not create video: ${error.message}`);
	}
	throw new Error("Could not allocate a video id");
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

export const videoTrim = (video: VideoRow) => ({
	start: video.trim_start_seconds,
	end: video.trim_end_seconds,
});

export const videoKept = (video: VideoRow) =>
	visibleRanges(video.duration_seconds, videoTrim(video), video.cuts ?? []);

export const isOpenVideo = (
	video: Pick<VideoRow, "visibility" | "password_hash">,
) => video.visibility === "public" && !video.password_hash;

export async function profileNames(db: SupabaseClient, ids: string[]) {
	const names = new Map<string, string>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return names;
	const { data, error } = await db
		.from("profiles")
		.select("id,full_name,email")
		.in("id", unique);
	if (error) throw new Error(`Could not load profiles: ${error.message}`);
	for (const row of data ?? [])
		names.set(
			row.id as string,
			displayName(row.full_name as string | null, row.email as string | null),
		);
	return names;
}
