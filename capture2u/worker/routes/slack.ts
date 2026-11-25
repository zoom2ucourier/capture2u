import { Hono } from "hono";
import { adminClient, getVideo, isOpenVideo, profileNames } from "../db";
import type { AppBindings, Env } from "../env";
import { constantTimeEqual, hmacSha256Hex } from "../lib/tokens";
import { isVideoId } from "../lib/util";

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_LINKS_PER_MESSAGE = 5;

export async function verifySlackSignature(
	signingSecret: string,
	timestamp: string | undefined,
	signature: string | undefined,
	rawBody: string,
	now: number = Date.now(),
) {
	if (!signingSecret || !timestamp || !signature) return false;
	const sentAt = Number(timestamp);
	if (
		!Number.isInteger(sentAt) ||
		Math.abs(Math.floor(now / 1000) - sentAt) > MAX_CLOCK_SKEW_SECONDS
	)
		return false;
	const expected = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
	return constantTimeEqual(expected, signature);
}

export function sharedVideoId(link: string, baseUrl: string) {
	try {
		const url = new URL(link);
		if (url.host !== new URL(baseUrl).host) return null;
		const id = /^\/v\/([a-z0-9]+)\/?$/.exec(url.pathname)?.[1];
		return id && isVideoId(id) ? id : null;
	} catch {
		return null;
	}
}

const plainText = (text: string, limit: number) => ({
	type: "plain_text",
	text: text.length > limit ? `${text.slice(0, limit - 1)}…` : text,
	emoji: true,
});

interface LinkSharedEvent {
	channel?: string;
	message_ts?: string;
	unfurl_id?: string;
	source?: string;
	links?: { url?: string }[];
}

async function unfurlLinks(env: Env, event: LinkSharedEvent) {
	const db = adminClient(env);
	const unfurls: Record<string, unknown> = {};

	for (const link of (event.links ?? []).slice(0, MAX_LINKS_PER_MESSAGE)) {
		if (!link.url) continue;
		const id = sharedVideoId(link.url, env.PUBLIC_BASE_URL);
		if (!id) continue;
		const video = await getVideo(db, id);
		if (
			!video ||
			!isOpenVideo(video) ||
			video.status !== "ready" ||
			!video.thumbnail_key
		)
			continue;
		const owner = (await profileNames(db, [video.owner_id])).get(
			video.owner_id,
		);
		unfurls[link.url] = {
			blocks: [
				{
					type: "video",
					title: plainText(video.title, 190),
					title_url: `${env.PUBLIC_BASE_URL}/v/${id}`,
					...(video.summary
						? { description: plainText(video.summary, 190) }
						: {}),
					video_url: `${env.PUBLIC_BASE_URL}/embed/${id}`,
					alt_text: video.title.slice(0, 190),
					thumbnail_url: `${env.PUBLIC_BASE_URL}/media/${id}/thumb.jpg`,
					...(owner ? { author_name: owner.slice(0, 49) } : {}),
					provider_name: "Capture2u",
				},
			],
		};
	}
	if (Object.keys(unfurls).length === 0) return;

	const target =
		event.unfurl_id && event.source
			? { unfurl_id: event.unfurl_id, source: event.source }
			: { channel: event.channel, ts: event.message_ts };
	const response = await fetch("https://slack.com/api/chat.unfurl", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({ ...target, unfurls }),
	});
	const result = (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		error?: string;
	};
	if (!result.ok)
		throw new Error(`Slack refused the preview: ${result.error ?? "unknown"}`);
}

export const slack = new Hono<AppBindings>();

slack.post("/events", async (c) => {
	const rawBody = await c.req.text();
	let payload: {
		type?: string;
		challenge?: string;
		event?: LinkSharedEvent & { type?: string };
	};
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return c.json({ error: "invalid_request" }, 400);
	}

	if (payload.type === "url_verification")
		return c.json({ challenge: payload.challenge ?? "" });

	if (!c.env.SLACK_SIGNING_SECRET || !c.env.SLACK_BOT_TOKEN)
		return c.json({ error: "slack_not_configured" }, 503);
	const signed = await verifySlackSignature(
		c.env.SLACK_SIGNING_SECRET,
		c.req.header("x-slack-request-timestamp"),
		c.req.header("x-slack-signature"),
		rawBody,
	);
	if (!signed) return c.json({ error: "invalid_signature" }, 401);

	const event = payload.event;
	if (payload.type === "event_callback" && event?.type === "link_shared")
		c.executionCtx.waitUntil(
			unfurlLinks(c.env, event).catch((cause) =>
				console.error("[capture2u] slack preview", cause),
			),
		);
	return c.json({ ok: true });
});
