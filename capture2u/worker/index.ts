import { Hono } from "hono";
import type { PublicConfig } from "../shared/types";
import { requireUser } from "./auth";
import { adminClient, getVideo } from "./db";
import type { AppBindings, Env, JobMessage } from "./env";
import { markProcessingFailed, processVideo } from "./jobs/process";
import { cleanStaleUploads, runRetention } from "./jobs/retention";
import { isVideoId, parseAllowedDomains, positiveInt } from "./lib/util";
import { media } from "./routes/media";
import { upload } from "./routes/upload";
import { videos } from "./routes/videos";
import { watch } from "./routes/watch";

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
	};
	return c.json(config, 200, { "Cache-Control": "public, max-age=300" });
});

app.get("/api/me", requireUser, (c) => c.json({ user: c.get("user") }));

app.route("/api/videos", videos);
app.route("/api/upload", upload);
app.route("/api/watch", watch);
app.route("/media", media);

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

const escapeAttribute = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

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
	try {
		const video = await getVideo(adminClient(c.env), id);
		if (video && video.visibility === "public" && !video.password_hash) {
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
		`<meta property="og:title" content="${escapeAttribute(title)}" />`,
		`<meta property="og:description" content="${escapeAttribute(description)}" />`,
		`<meta property="og:url" content="${escapeAttribute(new URL(`/v/${id}`, c.req.url).toString())}" />`,
		`<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
		`<meta name="robots" content="noindex" />`,
	];
	if (image)
		tags.push(
			`<meta property="og:image" content="${escapeAttribute(image)}" />`,
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
	fetch: app.fetch,

	async queue(batch: MessageBatch<JobMessage>, env: Env) {
		for (const message of batch.messages) {
			const job = message.body;
			if (job?.type !== "process-video" || !isVideoId(job.videoId)) {
				message.ack();
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
		env: Env,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(
			(async () => {
				await cleanStaleUploads(env).catch((error) =>
					console.error("[stale-upload]", error),
				);
				await runRetention(env).catch((error) =>
					console.error("[retention]", error),
				);
			})(),
		);
	},
} satisfies ExportedHandler<Env, JobMessage>;
