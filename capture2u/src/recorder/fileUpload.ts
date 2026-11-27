import { titleFromFileName, uploadFileKind } from "../../shared/uploads";
import { captureThumbnail, probeVideoFile } from "./media";
import {
	type CreatedVideo,
	createVideo,
	deleteVideo,
	uploadThumbnail,
	uploadWholeFile,
} from "./upload";

export async function uploadVideoFile(
	file: File,
	onProgress: (fraction: number) => void,
): Promise<CreatedVideo> {
	const kind = uploadFileKind(file);
	if (!kind) throw new Error("That file type is not supported.");
	const info = await probeVideoFile(file);
	const video = await createVideo({
		title: titleFromFileName(file.name),
		source: "upload",
	});
	try {
		const thumbnail = await captureThumbnail(file);
		if (thumbnail) await uploadThumbnail(video.id, thumbnail);
		await uploadWholeFile({
			videoId: video.id,
			blob: file,
			subpath: `upload.${kind.extension}`,
			contentType: kind.contentType,
			...info,
			seekable: true,
			onProgress,
		});
		return video;
	} catch (cause) {
		await deleteVideo(video.id).catch(() => undefined);
		throw cause;
	}
}
