import { adminClient, deleteVideo, VIDEO_COLUMNS, type VideoRow } from "../db";
import type { Env } from "../env";
import { positiveInt } from "../lib/util";

const MIN_RETENTION_DAYS = 30;
const MAX_PER_RUN_CEILING = 2000;
const STALE_UPLOAD_HOURS = 24;

export interface RetentionConfig {
	mode: "report" | "delete";
	days: number;
	maxPerRun: number;
}

// Anything other than the exact word "delete" keeps the job in report-only
// mode, so a missing or mistyped setting can never remove videos.
export function readRetentionConfig(
	env: Pick<Env, "RETENTION_MODE" | "RETENTION_DAYS" | "RETENTION_MAX_PER_RUN">,
): RetentionConfig {
	return {
		mode:
			env.RETENTION_MODE?.trim().toLowerCase() === "delete"
				? "delete"
				: "report",
		days: Math.max(MIN_RETENTION_DAYS, positiveInt(env.RETENTION_DAYS, 365)),
		maxPerRun: Math.min(
			MAX_PER_RUN_CEILING,
			positiveInt(env.RETENTION_MAX_PER_RUN, 200),
		),
	};
}

export const retentionCutoff = (days: number, now: Date) =>
	new Date(now.getTime() - days * 86_400_000);

export async function runRetention(env: Env, now: Date = new Date()) {
	const config = readRetentionConfig(env);
	const cutoff = retentionCutoff(config.days, now);
	const db = adminClient(env);

	const { data, error } = await db
		.from("videos")
		.select(VIDEO_COLUMNS)
		.eq("keep", false)
		.lt("created_at", cutoff.toISOString())
		.order("created_at", { ascending: true })
		.limit(config.maxPerRun);
	if (error) throw new Error(`Retention query failed: ${error.message}`);
	const candidates = (data ?? []) as unknown as VideoRow[];

	let deleted = 0;
	let failed = 0;
	const details: {
		id: string;
		title: string;
		createdAt: string;
		result: string;
	}[] = [];
	for (const video of candidates) {
		const entry = {
			id: video.id,
			title: video.title,
			createdAt: video.created_at,
		};
		if (config.mode === "report") {
			details.push({ ...entry, result: "would-delete" });
			continue;
		}
		try {
			await deleteVideo(env, db, video);
			deleted += 1;
			details.push({ ...entry, result: "deleted" });
		} catch (deleteError) {
			failed += 1;
			details.push({
				...entry,
				result: `failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
			});
		}
	}

	const summary = {
		mode: config.mode,
		cutoff: cutoff.toISOString(),
		candidates: candidates.length,
		deleted,
		failed,
	};
	await db.from("retention_runs").insert({ ...summary, details });
	console.log("[retention]", JSON.stringify(summary));
	return summary;
}

// Recordings that never finished uploading hold no playable video. They are
// removed after a day regardless of the retention mode.
export async function cleanStaleUploads(env: Env, now: Date = new Date()) {
	const db = adminClient(env);
	const cutoff = new Date(now.getTime() - STALE_UPLOAD_HOURS * 3_600_000);
	const { data, error } = await db
		.from("videos")
		.select(VIDEO_COLUMNS)
		.in("status", ["uploading", "failed"])
		.lt("created_at", cutoff.toISOString())
		.limit(200);
	if (error) throw new Error(`Stale upload query failed: ${error.message}`);
	let removed = 0;
	for (const video of (data ?? []) as unknown as VideoRow[]) {
		try {
			await deleteVideo(env, db, video);
			removed += 1;
		} catch (cleanupError) {
			console.error("[stale-upload]", video.id, cleanupError);
		}
	}
	console.log("[stale-upload]", JSON.stringify({ removed }));
	return removed;
}
