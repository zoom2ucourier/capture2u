import type { TimeRange } from "./timeline";

export type { TimeRange };

export type Visibility = "public" | "company" | "private";
export type VideoSource = "recording" | "extension" | "upload";
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

export interface PageLink {
	url: string;
	title: string | null;
	at: number;
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
	folderId: string | null;
	isOwner: boolean;
	ownerName: string | null;
}

export interface Folder {
	id: string;
	name: string;
	shared: boolean;
	isOwner: boolean;
	ownerName: string | null;
	videoCount: number;
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
	trimStart: number | null;
	trimEnd: number | null;
	cuts: TimeRange[];
	suggestedCuts: SuggestedCuts | null;
	optimized: boolean;
	width: number | null;
	height: number | null;
	viewCount: number;
	viewers: VideoViewers | null;
	createdAt: string;
	transcriptStatus: StageStatus;
	aiStatus: StageStatus;
	summary: string | null;
	chapters: Chapter[];
	pageLinks: PageLink[];
	transcript: TranscriptSegment[];
	playback: {
		token: string;
		videoUrl: string;
		posterUrl: string | null;
		captionsUrl: string | null;
		downloadUrl: string | null;
	} | null;
}

export interface SuggestedCuts {
	silences: TimeRange[];
	fillers: TimeRange[];
}

export interface VideoViewer {
	name: string;
	views: number;
	lastViewedAt: string;
}

export interface VideoViewers {
	people: VideoViewer[];
	anonymous: number;
}

export type CommentKind = "text" | "emoji";

export interface VideoComment {
	id: string;
	kind: CommentKind;
	body: string;
	timestampSeconds: number | null;
	parentId: string | null;
	createdAt: string;
	authorName: string;
	isMine: boolean;
	canDelete: boolean;
	mentions: Person[];
}

export interface Person {
	id: string;
	name: string;
}

export interface AccountSettings {
	slackAlerts: boolean;
}

export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "👏"] as const;

export const LOGIN_CODE_LENGTH = 6;

export interface PublicConfig {
	supabaseUrl: string;
	supabaseAnonKey: string;
	allowedDomains: string[];
	retentionDays: number;
	slackAlerts: boolean;
}

export interface ApiError {
	error: string;
	message?: string;
}
