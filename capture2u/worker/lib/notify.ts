import type { SupabaseClient } from "@supabase/supabase-js";
import type { VideoRow } from "../db";
import type { Env, SessionUser } from "../env";
import { commentEmail, firstViewEmail, sendEmail } from "./email";

const displayName = (user: SessionUser) =>
	user.fullName || user.email.split("@")[0] || "Someone";

async function recipients(db: SupabaseClient, ids: string[]) {
	if (ids.length === 0) return new Map<string, string>();
	const { data, error } = await db
		.from("profiles")
		.select("id,email,email_notifications")
		.in("id", ids);
	if (error) throw new Error(`Could not load recipients: ${error.message}`);
	return new Map(
		(data ?? [])
			.filter((row) => row.email_notifications !== false)
			.map((row) => [row.id as string, row.email as string]),
	);
}

export async function notifyComment(
	env: Env,
	db: SupabaseClient,
	video: VideoRow,
	actor: SessionUser,
	comment: { body: string; parentAuthorId: string | null },
) {
	const targets = [
		...new Set(
			[video.owner_id, comment.parentAuthorId].filter(
				(id): id is string => id !== null && id !== actor.id,
			),
		),
	];
	const emails = await recipients(db, targets);
	const url = `${env.PUBLIC_BASE_URL}/v/${video.id}`;
	for (const [id, to] of emails)
		await sendEmail(
			env,
			commentEmail({
				to,
				actorName: displayName(actor),
				videoTitle: video.title,
				body: comment.body,
				url,
				isReply: id === comment.parentAuthorId && id !== video.owner_id,
			}),
		);
}

export async function notifyFirstView(
	env: Env,
	db: SupabaseClient,
	video: VideoRow,
	viewer: SessionUser | null,
) {
	const { data: claimed, error } = await db
		.from("videos")
		.update({ first_view_notified_at: new Date().toISOString() })
		.eq("id", video.id)
		.is("first_view_notified_at", null)
		.select("id");
	if (error) throw new Error(`Could not mark first view: ${error.message}`);
	if (!claimed?.length) return;

	const to = (await recipients(db, [video.owner_id])).get(video.owner_id);
	if (!to) return;
	await sendEmail(
		env,
		firstViewEmail({
			to,
			viewerName: viewer ? displayName(viewer) : null,
			videoTitle: video.title,
			url: `${env.PUBLIC_BASE_URL}/v/${video.id}`,
		}),
	);
}
