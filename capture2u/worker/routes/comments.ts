import type { SupabaseClient } from "@supabase/supabase-js";
import { type Context, Hono } from "hono";
import {
	type CommentKind,
	REACTION_EMOJI,
	type VideoComment,
} from "../../shared/types";
import { requireUser } from "../auth";
import { profileNames, type VideoRow } from "../db";
import type { AppBindings, Env, SessionUser } from "../env";
import {
	escapeSlack,
	sendSlackAlerts,
	slackLink,
	slackQuote,
} from "../lib/slack";
import { displayName, isUuid } from "../lib/util";
import { loadWatchable } from "./watch";

const MAX_COMMENT_LENGTH = 4000;
const MAX_COMMENTS_PER_VIDEO = 1000;
const MAX_MENTIONS = 20;
const COMMENT_COLUMNS =
	"id,video_id,author_id,parent_id,kind,body,timestamp_seconds,mentions,created_at";

interface CommentRow {
	id: string;
	video_id: string;
	author_id: string;
	parent_id: string | null;
	kind: CommentKind;
	body: string;
	timestamp_seconds: number | null;
	mentions: string[] | null;
	created_at: string;
}

export function parseCommentInput(input: Record<string, unknown>):
	| {
			kind: CommentKind;
			body: string;
			timestampSeconds: number | null;
			parentId: string | null;
			mentions: string[];
	  }
	| "invalid" {
	const kind = input.kind === "emoji" ? "emoji" : "text";
	if (typeof input.body !== "string") return "invalid";
	const body = input.body.trim();
	if (kind === "emoji") {
		if (!(REACTION_EMOJI as readonly string[]).includes(body)) return "invalid";
	} else if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
		return "invalid";
	}

	let timestampSeconds: number | null = null;
	if (input.timestampSeconds !== null && input.timestampSeconds !== undefined) {
		const value = input.timestampSeconds;
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > 86_400
		)
			return "invalid";
		timestampSeconds = Math.round(value * 10) / 10;
	}

	let parentId: string | null = null;
	if (input.parentId !== null && input.parentId !== undefined) {
		if (kind === "emoji" || !isUuid(input.parentId)) return "invalid";
		parentId = input.parentId;
	}

	let mentions: string[] = [];
	if (input.mentions !== null && input.mentions !== undefined) {
		if (
			kind === "emoji" ||
			!Array.isArray(input.mentions) ||
			input.mentions.length > MAX_MENTIONS ||
			!input.mentions.every(isUuid)
		)
			return "invalid";
		mentions = [...new Set(input.mentions.map((id) => id.toLowerCase()))];
	}
	return { kind, body, timestampSeconds, parentId, mentions };
}

// One message per person, for the most specific reason they are involved:
// being mentioned beats being replied to, which beats owning the video.
export function commentAlerts(input: {
	authorId: string;
	ownerId: string;
	parentAuthorId: string | null;
	mentions: string[];
}) {
	const alerts = new Map<string, "mention" | "reply" | "comment">();
	if (input.ownerId !== input.authorId) alerts.set(input.ownerId, "comment");
	if (input.parentAuthorId && input.parentAuthorId !== input.authorId)
		alerts.set(input.parentAuthorId, "reply");
	for (const id of input.mentions)
		if (id !== input.authorId) alerts.set(id, "mention");
	return alerts;
}

async function alertAboutComment(
	env: Env,
	db: SupabaseClient,
	video: VideoRow,
	author: SessionUser,
	comment: { body: string; parentAuthorId: string | null; mentions: string[] },
) {
	const alerts = commentAlerts({
		authorId: author.id,
		ownerId: video.owner_id,
		parentAuthorId: comment.parentAuthorId,
		mentions: comment.mentions,
	});
	const name = escapeSlack(displayName(author.fullName, author.email));
	const link = slackLink(`${env.PUBLIC_BASE_URL}/v/${video.id}`, video.title);
	const quote = slackQuote(comment.body);
	const lead = {
		mention: `:speech_balloon: *${name}* mentioned you in a comment on ${link}`,
		reply: `:speech_balloon: *${name}* replied to your comment on ${link}`,
		comment: `:speech_balloon: *${name}* commented on ${link}`,
	};
	for (const reason of ["mention", "reply", "comment"] as const) {
		const recipients = [...alerts]
			.filter(([, why]) => why === reason)
			.map(([id]) => id);
		await sendSlackAlerts(
			env,
			db,
			recipients,
			[lead[reason], quote].join("\n"),
		);
	}
}

export const comments = new Hono<AppBindings>();

comments.use("*", requireUser);

const loadForComments = (c: Context<AppBindings>) =>
	loadWatchable(c.env, c.req.param("videoId") ?? "", {
		authorization: c.req.header("authorization"),
		unlockToken: c.req.header("x-unlock-token"),
	});

comments.get("/:videoId", async (c) => {
	const user = c.get("user");
	const loaded = await loadForComments(c);
	if (!loaded.ok) return c.json(loaded.body, loaded.status);
	const { db, video } = loaded;

	const { data, error } = await db
		.from("comments")
		.select(COMMENT_COLUMNS)
		.eq("video_id", video.id)
		.order("created_at", { ascending: true })
		.limit(MAX_COMMENTS_PER_VIDEO);
	if (error) throw new Error(`Could not list comments: ${error.message}`);
	const rows = (data ?? []) as CommentRow[];
	const names = await profileNames(
		db,
		rows.flatMap((row) => [row.author_id, ...(row.mentions ?? [])]),
	);
	const canModerate = video.owner_id === user.id || user.role === "admin";

	const result: VideoComment[] = rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		body: row.body,
		timestampSeconds: row.timestamp_seconds,
		parentId: row.parent_id,
		createdAt: row.created_at,
		authorName: names.get(row.author_id) ?? "Someone",
		isMine: row.author_id === user.id,
		canDelete: canModerate || row.author_id === user.id,
		mentions: (row.mentions ?? []).flatMap((id) => {
			const name = names.get(id);
			return name ? [{ id, name }] : [];
		}),
	}));
	return c.json({ comments: result }, 200, {
		"Cache-Control": "private, no-store",
	});
});

comments.post("/:videoId", async (c) => {
	const user = c.get("user");
	const loaded = await loadForComments(c);
	if (!loaded.ok) return c.json(loaded.body, loaded.status);
	const { db, video } = loaded;

	const input = parseCommentInput(
		(await c.req.json().catch(() => ({}))) as Record<string, unknown>,
	);
	if (input === "invalid") return c.json({ error: "invalid_comment" }, 400);

	if (input.kind === "emoji") {
		const { data: existing, error: lookupError } = await db
			.from("comments")
			.select("id")
			.eq("video_id", video.id)
			.eq("author_id", user.id)
			.eq("kind", "emoji")
			.eq("body", input.body)
			.maybeSingle();
		if (lookupError)
			throw new Error(`Could not load reaction: ${lookupError.message}`);
		if (existing) {
			const { error } = await db
				.from("comments")
				.delete()
				.eq("id", existing.id);
			if (error) throw new Error(`Could not remove reaction: ${error.message}`);
			return c.json({ removed: true });
		}
	}

	let parentAuthorId: string | null = null;
	if (input.parentId) {
		const { data: parent } = await db
			.from("comments")
			.select("id,video_id,parent_id,kind,author_id")
			.eq("id", input.parentId)
			.maybeSingle();
		if (
			!parent ||
			parent.video_id !== video.id ||
			parent.parent_id !== null ||
			parent.kind !== "text"
		)
			return c.json({ error: "invalid_comment" }, 400);
		parentAuthorId = parent.author_id as string;
	}

	let mentions: string[] = [];
	if (input.mentions.length > 0) {
		const { data: known, error: mentionError } = await db
			.from("profiles")
			.select("id")
			.in("id", input.mentions);
		if (mentionError)
			throw new Error(`Could not load mentions: ${mentionError.message}`);
		mentions = (known ?? []).map((row) => row.id as string);
	}

	const { count, error: countError } = await db
		.from("comments")
		.select("id", { count: "exact", head: true })
		.eq("video_id", video.id);
	if (countError)
		throw new Error(`Could not count comments: ${countError.message}`);
	if ((count ?? 0) >= MAX_COMMENTS_PER_VIDEO)
		return c.json({ error: "too_many_comments" }, 409);

	const { error } = await db.from("comments").insert({
		video_id: video.id,
		author_id: user.id,
		parent_id: input.parentId,
		kind: input.kind,
		body: input.body,
		timestamp_seconds: input.timestampSeconds,
		mentions,
	});
	if (error) {
		if (error.code === "23505") return c.json({ created: true });
		throw new Error(`Could not save comment: ${error.message}`);
	}

	if (input.kind === "text")
		c.executionCtx.waitUntil(
			alertAboutComment(c.env, db, video, user, {
				body: input.body,
				parentAuthorId,
				mentions,
			}).catch((cause) => console.error("[capture2u] comment alert", cause)),
		);

	return c.json({ created: true });
});

comments.delete("/:videoId/:commentId", async (c) => {
	const user = c.get("user");
	const commentId = c.req.param("commentId");
	if (!isUuid(commentId)) return c.json({ error: "not_found" }, 404);
	const loaded = await loadForComments(c);
	if (!loaded.ok) return c.json(loaded.body, loaded.status);
	const { db, video } = loaded;

	const { data: comment } = await db
		.from("comments")
		.select("id,video_id,author_id")
		.eq("id", commentId)
		.maybeSingle();
	if (!comment || comment.video_id !== video.id)
		return c.json({ error: "not_found" }, 404);
	if (
		comment.author_id !== user.id &&
		video.owner_id !== user.id &&
		user.role !== "admin"
	)
		return c.json({ error: "forbidden" }, 403);

	const { error } = await db.from("comments").delete().eq("id", commentId);
	if (error) throw new Error(`Could not delete comment: ${error.message}`);
	return c.json({ deleted: true });
});
