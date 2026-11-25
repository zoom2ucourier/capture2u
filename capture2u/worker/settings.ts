import type { Env, RawEnv } from "./env";

export const DEFAULT_SETTINGS = {
	ALLOWED_EMAIL_DOMAINS:
		"zoom2u.com,locate2u.com,locatetech.nz,freightmatch.com.au",
	RETENTION_MODE: "report",
	RETENTION_DAYS: "365",
	RETENTION_MAX_PER_RUN: "200",
	TRANSCRIBE_MODEL: "assemblyai/universal-3.5-pro",
	SUMMARY_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	EMAIL_FROM: "no-reply@capture2u.locate2u.com",
} as const;

const text = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : "";

// Settings live in the Cloudflare dashboard (Variables and Secrets), not in the
// repo. Anything left unset falls back to a safe default here, so the only
// value that must be added by hand is SUPABASE_SERVICE_ROLE_KEY.
export function resolveEnv(raw: RawEnv, origin?: string): Env {
	const serviceKey = text(raw.SUPABASE_SERVICE_ROLE_KEY);
	return {
		...raw,
		SUPABASE_URL: text(raw.SUPABASE_URL),
		SUPABASE_ANON_KEY: text(raw.SUPABASE_ANON_KEY),
		SUPABASE_SERVICE_ROLE_KEY: serviceKey,
		MEDIA_TOKEN_SECRET:
			text(raw.MEDIA_TOKEN_SECRET) ||
			(serviceKey ? `capture2u-media-v1:${serviceKey}` : ""),
		PUBLIC_BASE_URL: (text(raw.PUBLIC_BASE_URL) || text(origin)).replace(
			/\/+$/,
			"",
		),
		ALLOWED_EMAIL_DOMAINS:
			text(raw.ALLOWED_EMAIL_DOMAINS) || DEFAULT_SETTINGS.ALLOWED_EMAIL_DOMAINS,
		RETENTION_MODE: text(raw.RETENTION_MODE) || DEFAULT_SETTINGS.RETENTION_MODE,
		RETENTION_DAYS: text(raw.RETENTION_DAYS) || DEFAULT_SETTINGS.RETENTION_DAYS,
		RETENTION_MAX_PER_RUN:
			text(raw.RETENTION_MAX_PER_RUN) || DEFAULT_SETTINGS.RETENTION_MAX_PER_RUN,
		TRANSCRIBE_MODEL:
			text(raw.TRANSCRIBE_MODEL) || DEFAULT_SETTINGS.TRANSCRIBE_MODEL,
		SUMMARY_MODEL: text(raw.SUMMARY_MODEL) || DEFAULT_SETTINGS.SUMMARY_MODEL,
		EMAIL_FROM: text(raw.EMAIL_FROM) || DEFAULT_SETTINGS.EMAIL_FROM,
		SLACK_SIGNING_SECRET: text(raw.SLACK_SIGNING_SECRET),
		SLACK_BOT_TOKEN: text(raw.SLACK_BOT_TOKEN),
	};
}
