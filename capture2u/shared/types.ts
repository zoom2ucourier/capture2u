export type Visibility = "public" | "company" | "private";
export type VideoStatus = "uploading" | "ready" | "failed";
export type StageStatus =
	| "pending"
	| "processing"
	| "ready"
	| "failed"
	| "none";

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface Chapter {
	title: string;
	start: number;
}

export interface LibraryVideo {
	id: string;
	title: string;
	status: VideoStatus;
	visibility: Visibility;
	hasPassword: boolean;
	keep: boolean;
	durationSeconds: number | null;
	viewCount: number;
	createdAt: string;
	expiresAt: string | null;
	thumbnailUrl: string | null;
}

export interface WatchVideo {
	id: string;
	title: string;
	status: VideoStatus;
	visibility: Visibility;
	hasPassword: boolean;
	isOwner: boolean;
	keep: boolean | null;
	expiresAt: string | null;
	ownerName: string | null;
	ownerAvatarUrl: string | null;
	durationSeconds: number | null;
	width: number | null;
	height: number | null;
	viewCount: number;
	createdAt: string;
	transcriptStatus: StageStatus;
	aiStatus: StageStatus;
	summary: string | null;
	chapters: Chapter[];
	transcript: TranscriptSegment[];
	playback: {
		token: string;
		videoUrl: string;
		posterUrl: string | null;
		captionsUrl: string | null;
		downloadUrl: string | null;
	} | null;
}

export interface PublicConfig {
	supabaseUrl: string;
	supabaseAnonKey: string;
	allowedDomains: string[];
	retentionDays: number;
}

export interface ApiError {
	error: string;
	message?: string;
}
