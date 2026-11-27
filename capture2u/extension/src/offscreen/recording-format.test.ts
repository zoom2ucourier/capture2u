import { describe, expect, it } from "vitest";
import { selectRecordingFormat } from "./recording-format";

const supporting = (pattern: RegExp) => (mimeType: string) =>
	pattern.test(mimeType);

describe("recording format", () => {
	it("records MP4 (H.264 + AAC) when the browser can, even though WebM is available", () => {
		expect(selectRecordingFormat(true, () => true)).toEqual({
			mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
			fileExtension: "mp4",
		});
	});

	it("leaves the audio codec out when nothing is being heard", () => {
		expect(selectRecordingFormat(false, () => true)).toEqual({
			mimeType: 'video/mp4;codecs="avc1.42E01E"',
			fileExtension: "mp4",
		});
	});

	it("moves to the next H.264 profile when baseline is not offered", () => {
		expect(selectRecordingFormat(true, supporting(/avc1\.4d401e/))).toEqual({
			mimeType: 'video/mp4;codecs="avc1.4d401e,mp4a.40.2"',
			fileExtension: "mp4",
		});
	});

	it("falls back to WebM when MP4 cannot be recorded", () => {
		expect(selectRecordingFormat(true, supporting(/webm/))).toEqual({
			mimeType: "video/webm;codecs=vp9,opus",
			fileExtension: "webm",
		});
		expect(selectRecordingFormat(false, supporting(/webm/))).toEqual({
			mimeType: "video/webm;codecs=vp9",
			fileExtension: "webm",
		});
	});

	it("reports nothing when the browser cannot record at all", () => {
		expect(selectRecordingFormat(true, () => false)).toBeNull();
	});
});
