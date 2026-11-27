import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	type RecorderApiOptions,
} from "@cap/recorder-core/instant-mp4-uploader";
import { api, getAccessToken } from "../lib/api";

export interface CreatedVideo {
	id: string;
	shareUrl: string;
}

export const createVideo = (body: { title?: string; source?: "upload" } = {}) =>
	api<CreatedVideo>("/api/videos", { method: "POST", body });

export const deleteVideo = (id: string) =>
	api(`/api/videos/${id}`, { method: "DELETE" });

const TOKEN_REFRESH_MS = 4 * 60 * 1000;

// Sign-in tokens last about an hour and a recording can run longer, so the
// token the uploader sends is refreshed in place while it is in use.
export async function createUploadApi(extraBody?: Record<string, unknown>) {
	const options: RecorderApiOptions = {
		authToken: (await getAccessToken()) ?? undefined,
		extraBody,
	};
	const interval = window.setInterval(() => {
		void getAccessToken()
			.then((token) => {
				if (token) options.authToken = token;
			})
			.catch(() => undefined);
	}, TOKEN_REFRESH_MS);
	return { options, release: () => window.clearInterval(interval) };
}

export async function uploadThumbnail(videoId: string, thumbnail: Blob) {
	const token = await getAccessToken();
	if (!token) return;
	await fetch(`/api/upload/thumbnail/${videoId}`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "image/jpeg",
		},
		body: thumbnail,
	}).catch(() => undefined);
}

export interface WholeUpload {
	videoId: string;
	blob: Blob;
	subpath: string;
	contentType: string;
	durationSeconds?: number;
	width?: number;
	height?: number;
	seekable: boolean;
	onProgress?: (fraction: number) => void;
}

export async function uploadWholeFile(upload: WholeUpload) {
	const uploadApi = await createUploadApi(
		upload.seekable ? { seekable: true } : undefined,
	);
	try {
		const session = await initiateMultipartUpload({
			videoId: upload.videoId,
			contentType: upload.contentType,
			subpath: upload.subpath,
			api: uploadApi.options,
		});
		const uploader = new InstantRecordingUploader({
			videoId: upload.videoId,
			uploadId: session.uploadId,
			mimeType: upload.contentType,
			subpath: upload.subpath,
			setUploadStatus: () => undefined,
			sendProgressUpdate: async (uploaded, total) => {
				if (total > 0) upload.onProgress?.(Math.min(1, uploaded / total));
			},
			api: uploadApi.options,
		});
		await uploader.finalize({
			finalBlob: upload.blob,
			durationSeconds: upload.durationSeconds ?? 0,
			width: upload.width,
			height: upload.height,
			subpath: upload.subpath,
		});
		upload.onProgress?.(1);
	} finally {
		uploadApi.release();
	}
}
