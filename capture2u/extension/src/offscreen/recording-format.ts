import { WEBM_MIME_TYPES } from "@cap/recorder-core";

export type RecordingFormat = {
	mimeType: string;
	fileExtension: "mp4" | "webm";
};

// Baseline first, as in Cap's recorder. Chrome can always encode it in
// software; asking for High profile on a machine with no hardware encoder
// (seen in headless Chrome 158) produced a frozen, corrupt file.
const H264_PROFILES = ["avc1.42E01E", "avc1.4d401e", "avc1.640028"];

const MP4_WITH_AUDIO = H264_PROFILES.map(
	(profile) => `video/mp4;codecs="${profile},mp4a.40.2"`,
);
const MP4_VIDEO_ONLY = H264_PROFILES.map(
	(profile) => `video/mp4;codecs="${profile}"`,
);

// Cap's recorder prefers WebM in Chrome because Cap's servers transcode it.
// Capture2u has no transcoder: the Worker only rewrites MP4 so it can seek,
// and MP4 (H.264 + AAC) is what plays everywhere. So the extension records
// MP4 first, the same choice the Capture2u site makes, and keeps WebM as the
// fallback for browsers that cannot record MP4.
export const selectRecordingFormat = (
	hasAudio: boolean,
	isSupported: (mimeType: string) => boolean = (mimeType) =>
		typeof MediaRecorder !== "undefined" &&
		MediaRecorder.isTypeSupported(mimeType),
): RecordingFormat | null => {
	const mp4Candidates = hasAudio
		? [...MP4_WITH_AUDIO, ...MP4_VIDEO_ONLY, "video/mp4"]
		: [...MP4_VIDEO_ONLY, ...MP4_WITH_AUDIO, "video/mp4"];
	const mp4 = mp4Candidates.find(isSupported);
	if (mp4) return { mimeType: mp4, fileExtension: "mp4" };

	const webmCandidates = hasAudio
		? [...WEBM_MIME_TYPES.withAudio, ...WEBM_MIME_TYPES.videoOnly]
		: [...WEBM_MIME_TYPES.videoOnly, ...WEBM_MIME_TYPES.withAudio];
	const webm = webmCandidates.find(isSupported);
	if (webm) return { mimeType: webm, fileExtension: "webm" };

	return null;
};
