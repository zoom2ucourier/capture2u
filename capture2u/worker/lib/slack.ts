import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

const LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_QUOTE_CHARS = 280;

export const slackConfigured = (env: Pick<Env, "SLACK_BOT_TOKEN">) =>
	Boolean(env.SLACK_BOT_TOKEN);

export const escapeSlack = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const slackLink = (url: string, label: string) =>
	`<${url}|${escapeSlack(label).replace(/\|/g, "¦")}>`;

export const slackQuote = (text: string) => {
	const clipped =
		text.length > MAX_QUOTE_CHARS
			? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…`
			: text;
	return escapeSlack(clipped)
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
};

async function slackCall(
	env: Env,
	method: string,
	init: { query?: Record<string, string>; body?: Record<string, unknown> },
) {
	const url = new URL(`https://slack.com/api/${method}`);
	for (const [key, value] of Object.entries(init.query ?? {}))
		url.searchParams.set(key, value);
	const response = await fetch(url, {
		method: init.body ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			...(init.body
				? { "Content-Type": "application/json; charset=utf-8" }
				: {}),
		},
		body: init.body ? JSON.stringify(init.body) : undefined,
	});
	return (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		error?: string;
		user?: { id?: string };
	};
}

interface AlertProfile {
	id: string;
	email: string;
	slack_alerts: boolean;
	slack_user_id: string | null;
	slack_checked_at: string | null;
}

async function slackUserId(
	env: Env,
	db: SupabaseClient,
	profile: AlertProfile,
	now: number,
) {
	if (profile.slack_user_id) return profile.slack_user_id;
	if (
		profile.slack_checked_at &&
		now - new Date(profile.slack_checked_at).getTime() < LOOKUP_RETRY_MS
	)
		return null;

	const result = await slackCall(env, "users.lookupByEmail", {
		query: { email: profile.email },
	});
	const found = result.ok && result.user?.id ? result.user.id : null;
	if (!found && result.error !== "users_not_found")
		console.error("[capture2u] slack lookup", result.error ?? "unknown");
	if (found || result.error === "users_not_found")
		await db
			.from("profiles")
			.update({
				slack_user_id: found,
				slack_checked_at: new Date(now).toISOString(),
			})
			.eq("id", profile.id);
	return found;
}

// Sends one direct message per recipient. Anything that goes wrong is logged
// and swallowed: an alert must never fail the view or comment that caused it.
export async function sendSlackAlerts(
	env: Env,
	db: SupabaseClient,
	recipientIds: string[],
	text: string,
	now: number = Date.now(),
) {
	const unique = [...new Set(recipientIds)];
	if (!slackConfigured(env) || unique.length === 0) return;
	try {
		const { data, error } = await db
			.from("profiles")
			.select("id,email,slack_alerts,slack_user_id,slack_checked_at")
			.in("id", unique);
		if (error) throw new Error(error.message);
		for (const profile of (data ?? []) as AlertProfile[]) {
			if (!profile.slack_alerts) continue;
			const channel = await slackUserId(env, db, profile, now);
			if (!channel) continue;
			const result = await slackCall(env, "chat.postMessage", {
				body: { channel, text, unfurl_links: false, unfurl_media: false },
			});
			if (!result.ok)
				console.error("[capture2u] slack alert", result.error ?? "unknown");
		}
	} catch (cause) {
		console.error("[capture2u] slack alert", cause);
	}
}
