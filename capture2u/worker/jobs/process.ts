import { adminClient, getVideo, type VideoRow } from "../db";
import type { Env } from "../env";
import { createToken } from "../lib/tokens";
import {
	normalizeTranscript,
	parseAiSummary,
	transcriptForPrompt,
} from "../lib/transcript";

const MEDIA_FETCH_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const FALLBACK_TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const PROMPT_TRANSCRIPT_CHARS = 24_000;
const MIN_TRANSCRIPT_CHARS_FOR_AI = 40;

const runModel = (env: Env, model: string, input: Record<string, unknown>) =>
	(
		env.AI as unknown as {
			run: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
		}
	).run(model, input);

const toBase64 = (bytes: ArrayBuffer) => {
	const view = new Uint8Array(bytes);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < view.length; i += chunk)
		binary += String.fromCharCode(...view.subarray(i, i + chunk));
	return btoa(binary);
};

async function transcribeWith(env: Env, video: VideoRow, model: string) {
	if (!video.object_key) throw new Error("Video has no stored file");

	// Whisper on Workers AI takes the file inline, so it only suits recordings
	// small enough to hold in memory. URL-based models read the file from this
	// Worker's own media route using a short-lived token.
	if (model.startsWith("@cf/openai/whisper")) {
		const object = await env.VIDEOS.get(video.object_key);
		if (!object) throw new Error("Stored file is missing");
		if (object.size > WHISPER_MAX_BYTES)
			throw new Error("Recording is too large for the inline speech model");
		const raw = await runModel(env, model, {
			audio: toBase64(await object.arrayBuffer()),
		});
		return normalizeTranscript(raw, {
			timesInMilliseconds: false,
			durationSeconds: video.duration_seconds,
		});
	}

	const token = await createToken(
		env.MEDIA_TOKEN_SECRET,
		"play",
		video.id,
		MEDIA_FETCH_TOKEN_TTL_SECONDS,
	);
	if (!env.PUBLIC_BASE_URL)
		throw new Error("No public address is known for this video");
	const audioUrl = `${env.PUBLIC_BASE_URL}/media/${video.id}/video?t=${encodeURIComponent(token)}`;
	const raw = await runModel(env, model, { audio_url: audioUrl });
	return normalizeTranscript(raw, {
		timesInMilliseconds: model.startsWith("assemblyai/"),
		durationSeconds: video.duration_seconds,
	});
}

async function transcribe(env: Env, video: VideoRow) {
	try {
		return await transcribeWith(env, video, env.TRANSCRIBE_MODEL);
	} catch (error) {
		if (env.TRANSCRIBE_MODEL === FALLBACK_TRANSCRIBE_MODEL) throw error;
		console.error(
			"[capture2u] speech model failed, trying the built-in one",
			video.id,
			error,
		);
		return transcribeWith(env, video, FALLBACK_TRANSCRIBE_MODEL);
	}
}

const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		summary: { type: "string" },
		chapters: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					start: { type: "number" },
				},
				required: ["title", "start"],
			},
		},
	},
	required: ["title", "summary", "chapters"],
};

async function summarize(
	env: Env,
	video: VideoRow,
	transcript: ReturnType<typeof normalizeTranscript>,
) {
	const raw = await runModel(env, env.SUMMARY_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"You write metadata for workplace screen recordings. Reply with JSON only: a short specific title (max 8 words, no quotes), a summary of 2 to 4 plain sentences, and chapters. Each chapter has a title and a start time in seconds taken from the [mm:ss] markers. Use 1 chapter per major topic, at most 8, and none if the recording is under 2 minutes. Never invent content that is not in the transcript.",
			},
			{
				role: "user",
				content: `Recording length: ${Math.round(video.duration_seconds ?? 0)} seconds.\n\nTranscript:\n${transcriptForPrompt(transcript.segments, PROMPT_TRANSCRIPT_CHARS)}`,
			},
		],
		response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA },
		max_tokens: 900,
		temperature: 0.2,
	});
	return parseAiSummary(raw, video.duration_seconds);
}

export async function processVideo(env: Env, videoId: string) {
	const db = adminClient(env);
	const video = await getVideo(db, videoId);
	if (!video || video.status !== "ready") return;

	const update = async (fields: Record<string, unknown>) => {
		const { error } = await db.from("videos").update(fields).eq("id", videoId);
		if (error) throw new Error(`Could not update video: ${error.message}`);
	};

	let transcript: ReturnType<typeof normalizeTranscript>;
	if (video.transcript_status === "ready" && video.transcript_segments) {
		transcript = {
			text: video.transcript_text ?? "",
			segments: video.transcript_segments,
		};
	} else {
		await update({ transcript_status: "processing" });
		transcript = await transcribe(env, video);
		if (!transcript.text) {
			await update({ transcript_status: "none", ai_status: "none" });
			return;
		}
		await update({
			transcript_status: "ready",
			transcript_text: transcript.text,
			transcript_segments: transcript.segments,
		});
	}

	if (video.ai_status === "ready") return;
	if (transcript.text.length < MIN_TRANSCRIPT_CHARS_FOR_AI) {
		await update({ ai_status: "none" });
		return;
	}

	await update({ ai_status: "processing" });
	const ai = await summarize(env, video, transcript);
	const fields: Record<string, unknown> = {
		ai_status: "ready",
		summary: ai.summary,
		chapters: ai.chapters,
	};
	// Re-read so a title the owner typed while this ran is not overwritten.
	const latest = await getVideo(db, videoId);
	if (ai.title && latest && !latest.title_edited) fields.title = ai.title;
	await update(fields);
}

export async function markProcessingFailed(env: Env, videoId: string) {
	const db = adminClient(env);
	const video = await getVideo(db, videoId);
	if (!video) return;
	const fields: Record<string, unknown> = {};
	if (video.transcript_status !== "ready" && video.transcript_status !== "none")
		fields.transcript_status = "failed";
	if (video.ai_status !== "ready" && video.ai_status !== "none")
		fields.ai_status = "failed";
	if (Object.keys(fields).length > 0)
		await db.from("videos").update(fields).eq("id", videoId);
}
