export type JobMessage = {
	type: "process-video";
	videoId: string;
	origin?: string;
};

export interface Bindings {
	ASSETS: Fetcher;
	VIDEOS: R2Bucket;
	AI: Ai;
	JOBS: Queue<JobMessage>;
	EMAIL?: SendEmail;
}

export interface Settings {
	PUBLIC_BASE_URL: string;
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	MEDIA_TOKEN_SECRET: string;
	ALLOWED_EMAIL_DOMAINS: string;
	RETENTION_MODE: string;
	RETENTION_DAYS: string;
	RETENTION_MAX_PER_RUN: string;
	TRANSCRIBE_MODEL: string;
	SUMMARY_MODEL: string;
	EMAIL_FROM: string;
	SLACK_SIGNING_SECRET: string;
	SLACK_BOT_TOKEN: string;
}

export type Env = Bindings & Settings;
export type RawEnv = Bindings & Partial<Settings>;

export interface SessionUser {
	id: string;
	email: string;
	role: "member" | "admin";
	fullName: string | null;
}

export type AppBindings = {
	Bindings: Env;
	Variables: { user: SessionUser };
};
