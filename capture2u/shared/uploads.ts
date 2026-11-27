export const UPLOAD_ACCEPT =
	"video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v";
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
};

export function uploadFileKind(file: { name: string; type: string }) {
	const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
	const extension =
		fromName in CONTENT_TYPES
			? fromName
			: (Object.entries(CONTENT_TYPES).find(
					([, type]) => type === file.type,
				)?.[0] ?? null);
	if (!extension) return null;
	return { extension, contentType: CONTENT_TYPES[extension] ?? "video/mp4" };
}

export const titleFromFileName = (name: string) =>
	name
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/_+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200) || "Uploaded video";

export function uploadFileProblem(file: {
	name: string;
	type: string;
	size: number;
}) {
	if (!uploadFileKind(file))
		return "That file type is not supported. Use an MP4, MOV or WebM video.";
	if (file.size === 0) return "That file is empty.";
	if (file.size > MAX_UPLOAD_BYTES)
		return "That file is too large. The limit is 4 GB.";
	return null;
}

// The uploader reports a refused start as text. 409 means the server already
// holds the finished video; 403 and 404 mean the video is gone or belongs to
// another account.
export const refusedStartStatus = (cause: unknown) => {
	if (!(cause instanceof Error)) return null;
	const match = /\/multipart\/initiate failed: (\d{3}) /.exec(cause.message);
	return match ? Number(match[1]) : null;
};
