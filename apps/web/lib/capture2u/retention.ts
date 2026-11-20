import "server-only";

import { db } from "@cap/database";
import { comments, notifications, users, videos } from "@cap/database/schema";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

export type RetentionMode = "report" | "delete";

export interface RetentionConfig {
	mode: RetentionMode;
	days: number;
	maxPerRun: number;
}

export type RetentionCandidate = Pick<
	typeof videos.$inferSelect,
	"id" | "ownerId" | "name" | "createdAt"
>;

export interface RetentionSummary {
	mode: RetentionMode;
	retentionDays: number;
	cutoff: string;
	maxPerRun: number;
	candidates: number;
	deleted: number;
	failed: number;
	moreRemaining: boolean;
	videos: {
		id: string;
		name: string;
		createdAt: string;
		result: "would-delete" | "deleted" | "failed";
		error?: string;
	}[];
}

const DEFAULT_DAYS = 365;
const MIN_DAYS = 30;
const DEFAULT_MAX_PER_RUN = 200;
const MAX_MAX_PER_RUN = 2000;

function positiveInt(value: string | undefined) {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Anything other than an explicit "delete" keeps the job in report-only mode,
// so a missing or mistyped setting can never remove videos.
export function readRetentionConfig(
	env: Record<string, string | undefined> = process.env,
): RetentionConfig {
	const days = Math.max(
		MIN_DAYS,
		positiveInt(env.CAPTURE2U_RETENTION_DAYS) ?? DEFAULT_DAYS,
	);
	const maxPerRun = Math.min(
		MAX_MAX_PER_RUN,
		positiveInt(env.CAPTURE2U_RETENTION_MAX_PER_RUN) ?? DEFAULT_MAX_PER_RUN,
	);
	const mode: RetentionMode =
		env.CAPTURE2U_RETENTION_MODE?.trim().toLowerCase() === "delete"
			? "delete"
			: "report";
	return { mode, days, maxPerRun };
}

export function retentionCutoff(days: number, now: Date = new Date()) {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// The clock runs from when the video arrived (`createdAt`). The date an owner
// can edit for display (`customCreatedAt`) is deliberately ignored.
export async function findRetentionCandidates(
	cutoff: Date,
	limit: number,
): Promise<RetentionCandidate[]> {
	return db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
		})
		.from(videos)
		.where(
			and(
				lt(videos.createdAt, cutoff),
				sql`COALESCE(JSON_EXTRACT(${videos.metadata}, '$.keep'), CAST('false' AS JSON)) <> CAST('true' AS JSON)`,
			),
		)
		.orderBy(asc(videos.createdAt))
		.limit(limit);
}

async function deleteOne(candidate: RetentionCandidate) {
	const [owner] = await db()
		.select()
		.from(users)
		.where(eq(users.id, candidate.ownerId));
	if (!owner) throw new Error("Owner account no longer exists");

	await Effect.gen(function* () {
		const videoService = yield* Videos;
		yield* videoService.delete(candidate.id);
	}).pipe(Effect.provide(makeCurrentUserLayer(owner)), runPromise);

	// Cap's delete leaves these rows behind.
	await db().delete(comments).where(eq(comments.videoId, candidate.id));
	await db()
		.delete(notifications)
		.where(eq(notifications.videoId, candidate.id));
}

function describeError(error: unknown) {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error).slice(0, 300);
	} catch {
		return String(error);
	}
}

export async function runRetention(
	config: RetentionConfig = readRetentionConfig(),
	now: Date = new Date(),
): Promise<RetentionSummary> {
	const cutoff = retentionCutoff(config.days, now);
	const found = await findRetentionCandidates(cutoff, config.maxPerRun + 1);
	const moreRemaining = found.length > config.maxPerRun;
	const batch = found.slice(0, config.maxPerRun);

	const summary: RetentionSummary = {
		mode: config.mode,
		retentionDays: config.days,
		cutoff: cutoff.toISOString(),
		maxPerRun: config.maxPerRun,
		candidates: batch.length,
		deleted: 0,
		failed: 0,
		moreRemaining,
		videos: [],
	};

	for (const candidate of batch) {
		const entry = {
			id: candidate.id as string,
			name: candidate.name,
			createdAt: candidate.createdAt.toISOString(),
		};
		if (config.mode === "report") {
			summary.videos.push({ ...entry, result: "would-delete" });
			continue;
		}
		try {
			await deleteOne(candidate);
			summary.deleted += 1;
			summary.videos.push({ ...entry, result: "deleted" });
		} catch (error) {
			summary.failed += 1;
			const message = describeError(error);
			console.error(
				`[capture2u-retention] failed to delete ${candidate.id}: ${message}`,
			);
			summary.videos.push({ ...entry, result: "failed", error: message });
		}
	}

	console.log(
		`[capture2u-retention] mode=${summary.mode} cutoff=${summary.cutoff} candidates=${summary.candidates} deleted=${summary.deleted} failed=${summary.failed} moreRemaining=${summary.moreRemaining}`,
	);
	return summary;
}
