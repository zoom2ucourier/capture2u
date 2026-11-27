import { Hono } from "hono";
import type { PublicConfig } from "../shared/types";
import { requireUser } from "./auth";
import { adminClient, getVideo, isOpenVideo, profileNames } from "./db";
import type { AppBindings, JobMessage, RawEnv } from "./env";
import { cleanFirstUploads, optimizeVideo } from "./jobs/optimize";
import { markProcessingFailed, processVideo } from "./jobs/process";
import { cleanStaleUploads, runRetention } from "./jobs/retention";
import { slackConfigured } from "./lib/slack";
import {
	embedHtml,
	escapeHtml,
	isVideoId,
	parseAllowedDomains,
	positiveInt,
} from "./lib/util";
import { account } from "./routes/account";
import { auth } from "./routes/auth";
import { comments } from "./routes/comments";
import { extension } from "./routes/extension";
import { folders } from "./routes/folders";
import { media } from "./routes/media";
import { sharedVideoId, slack } from "./routes/slack";
import { upload } from "./routes/upload";
import { videos } from "./routes/videos";
import { watch } from "./routes/watch";
import { resolveEnv } from "./settings";

const app = new Hono<AppBindings>();

app.onError((error, c) => {
	console.error("[capture2u]", c.req.method, c.req.path, error);
	return c.json({ error: "server_error" }, 500);
});

app.get("/api/config", (c) => {
	const config: PublicConfig = {
		supabaseUrl: c.env.SUPABASE_URL,
		supabaseAnonKey: c.env.SUPABASE_ANON_KEY,
		allowedDomains: parseAllowedDomains(c.env.ALLOWED_EMAIL_DOMAINS),
		retentionDays: positiveInt(c.env.RETENTION_DAYS, 365),
		slackAlerts: slackConfigured(c.env),
	};
	return c.json(config, 200, { "Cache-Control": "public, max-age=300" });
});

app.get("/api/me", requireUser, (c) => c.json({ user: c.get("user") }));
app.route("/api/account", account);
app.route("/api/extension", extension);

app.get("/api/oembed", async (c) => {
	const id = sharedVideoId(c.req.query("url") ?? "", c.env.PUBLIC_BASE_URL);
	const format = c.req.query("format");
	if (format && format !== "json")
		return c.json({ error: "not_implemented" }, 501);
	if (!id) return c.json({ error: "not_found" }, 404);
	const db = adminClient(c.env);
	const video = await getVideo(db, id);
	if (!video || !isOpenVideo(video) || video.status !== "ready")
		return c.json({ error: "not_found" }, 404);
	const owner = (await profileNames(db, [video.owner_id])).get(video.owner_id);
	return c.json(
		{
			version: "1.0",
			type: "video",
			provider_name: "Capture2u",
			provider_url: c.env.PUBLIC_BASE_URL,
			title: video.title,
			author_name: owner,
			html: embedHtml(c.env.PUBLIC_BASE_URL, id, video.title),
			width: 640,
			height: 360,
			...(video.thumbnail_key
				? {
						thumbnail_url: `${c.env.PUBLIC_BASE_URL}/media/${id}/thumb.jpg`,
						thumbnail_width: 1280,
						thumbnail_height: 720,
					}
				: {}),
		},
		200,
		{ "Cache-Control": "public, max-age=300" },
	);
});

app.route("/api/auth", auth);
app.route("/api/videos", videos);
app.route("/api/folders", folders);
app.route("/api/comments", comments);
app.route("/api/upload", upload);
app.route("/api/watch", watch);
app.route("/api/slack", slack);
app.route("/media", media);

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// The share page is the single-page app, served with link-preview tags added
// so a pasted link shows a title and thumbnail in Slack and elsewhere. Locked
// videos get a generic card that reveals nothing.
app.get("/v/:id", async (c) => {
	const page = await c.env.ASSETS.fetch(
		new Request(new URL("/index.html", c.req.url)),
	);
	const id = c.req.param("id");
	if (!page.ok || !isVideoId(id)) return page;

	let title = "Capture2u recording";
	let description = "Watch this recording on Capture2u.";
	let image: string | null = null;
	let embeddable = false;
	try {
		const video = await getVideo(adminClient(c.env), id);
		if (video && isOpenVideo(video)) {
			embeddable = video.status === "ready";
			title = video.title;
			if (video.summary) description = video.summary.slice(0, 300);
			if (video.thumbnail_key)
				image = new URL(`/media/${id}/thumb.jpg`, c.req.url).toString();
		}
	} catch (error) {
		console.error("[capture2u] share preview", error);
	}

	const tags = [
		`<meta property="og:site_name" content="Capture2u" />`,
		`<meta property="og:type" content="video.other" />`,
		`<meta property="og:title" content="${escapeHtml(title)}" />`,
		`<meta property="og:description" content="${escapeHtml(description)}" />`,
		`<meta property="og:url" content="${escapeHtml(new URL(`/v/${id}`, c.req.url).toString())}" />`,
		`<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
		`<meta name="robots" content="noindex" />`,
	];
	if (image)
		tags.push(`<meta property="og:image" content="${escapeHtml(image)}" />`);
	if (embeddable)
		tags.push(
			`<link rel="alternate" type="application/json+oembed" href="${escapeHtml(
				new URL(
					`/api/oembed?url=${encodeURIComponent(new URL(`/v/${id}`, c.req.url).toString())}`,
					c.req.url,
				).toString(),
			)}" title="${escapeHtml(title)}" />`,
		);

	return new HTMLRewriter()
		.on("title", {
			element(element) {
				element.setInnerContent(`${title} | Capture2u`);
			},
		})
		.on("head", {
			element(element) {
				element.append(tags.join("\n"), { html: true });
			},
		})
		.transform(
			new Response(page.body, {
				status: page.status,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "private, no-store",
				},
			}),
		);
});

export default {
	fetch: (request: Request, raw: RawEnv, ctx: ExecutionContext) =>
		app.fetch(request, resolveEnv(raw, new URL(request.url).origin), ctx),

	async queue(batch: MessageBatch<JobMessage>, raw: RawEnv) {
		for (const message of batch.messages) {
			const job = message.body;
			const env = resolveEnv(raw, job?.origin);
			if (
				(job?.type !== "process-video" && job?.type !== "optimize-video") ||
				!isVideoId(job.videoId)
			) {
				message.ack();
				continue;
			}
			if (job.type === "optimize-video") {
				try {
					await optimizeVideo(env, job.videoId);
					message.ack();
				} catch (error) {
					console.error("[capture2u] optimize-video", job.videoId, error);
					if (message.attempts >= 3) message.ack();
					else message.retry({ delaySeconds: 120 });
				}
				continue;
			}
			try {
				await processVideo(env, job.videoId);
				message.ack();
			} catch (error) {
				console.error("[capture2u] process-video", job.videoId, error);
				if (message.attempts >= 3) {
					await markProcessingFailed(env, job.videoId).catch(() => {});
					message.ack();
				} else {
					message.retry({ delaySeconds: 60 });
				}
			}
		}
	},

	async scheduled(
		_controller: ScheduledController,
		raw: RawEnv,
		ctx: ExecutionContext,
	) {
		const env = resolveEnv(raw);
		ctx.waitUntil(
			(async () => {
				await cleanStaleUploads(env).catch((error) =>
					console.error("[stale-upload]", error),
				);
				await cleanFirstUploads(env).catch((error) =>
					console.error("[first-upload]", error),
				);
				await runRetention(env).catch((error) =>
					console.error("[retention]", error),
				);
			})(),
		);
	},
} satisfies ExportedHandler<RawEnv, JobMessage>;
