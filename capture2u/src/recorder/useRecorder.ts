import {
	type AudioMixer,
	acquireDisplayStream,
	acquireMicStream,
	createAudioMixer,
	getCaptureErrorMessage,
} from "@cap/recorder-core/capture-streams";
import {
	InstantRecordingUploader,
	initiateMultipartUpload,
} from "@cap/recorder-core/instant-mp4-uploader";
import type { DetectedDisplayRecordingMode } from "@cap/recorder-core/recorder-constants";
import { isUserCancellationError } from "@cap/recorder-core/recorder-utils";
import {
	canUseRecordingSpool,
	RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS,
	RecordingSpool,
} from "@cap/recorder-core/recording-spool";
import { useCallback, useEffect, useRef, useState } from "react";
import { refusedStartStatus } from "../../shared/uploads";
import {
	captureThumbnail,
	captureTrackThumbnail,
	pickRecordingFormat,
	type RecordingFormat,
	toSeekableMp4,
} from "./media";
import {
	recordingLockName,
	removeRecordingMeta,
	saveRecordingMeta,
} from "./recovery";
import {
	type CreatedVideo,
	createUploadApi,
	createVideo,
	deleteVideo,
	uploadThumbnail,
	uploadWholeFile,
} from "./upload";
import {
	type BubblePositionRef,
	canCompositeVideo,
	createVideoCompositor,
	type VideoCompositor,
} from "./videoCompositor";

export type RecorderPhase =
	| "idle"
	| "starting"
	| "recording"
	| "paused"
	| "finishing"
	| "uploading"
	| "done"
	| "error";

export interface RecorderOptions {
	mode: DetectedDisplayRecordingMode;
	microphoneId: string | null;
	systemAudio: boolean;
	camera: { stream: MediaStream; position: BubblePositionRef } | null;
}

export interface RecorderPreview {
	stream: MediaStream;
	width: number;
	height: number;
	cameraInVideo: boolean;
	entireScreen: boolean;
}

export interface FinishedRecording {
	blob: Blob;
	fileName: string;
	durationSeconds: number;
	width?: number;
	height?: number;
	format: RecordingFormat;
	seekable: boolean;
}

// One attempt at a recording. The pieces the browser produces go three ways
// at once: kept in memory, written to this browser's storage in case of a
// crash, and uploaded so the link works the moment recording stops.
interface Take {
	video: Promise<CreatedVideo>;
	sessionId: string;
	chunks: Blob[];
	bytes: number;
	waiting: Blob[];
	uploader: InstantRecordingUploader | null;
	subpath: string;
	uploadFailed: boolean;
	ready: Promise<void>;
	spool: RecordingSpool | null;
	thumbnailSent: boolean;
	cleanups: (() => void)[];
	closed: boolean;
}

const VIDEO_BITS_PER_SECOND = 2_500_000;
const AUDIO_BITS_PER_SECOND = 128_000;
const THUMBNAIL_DELAY_MS = 1500;

const newSessionId = () =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `recording-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function closeTake(take: Take | null) {
	if (!take || take.closed) return;
	take.closed = true;
	for (const cleanup of take.cleanups) cleanup();
	take.cleanups = [];
}

async function forgetTake(take: Take | null) {
	if (!take) return;
	take.uploader?.suspend();
	closeTake(take);
	removeRecordingMeta(take.sessionId);
	await take.spool?.dispose().catch(() => undefined);
}

export function useRecorder() {
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [progress, setProgress] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [share, setShare] = useState<CreatedVideo | null>(null);
	const [finished, setFinished] = useState<FinishedRecording | null>(null);
	const [preview, setPreview] = useState<RecorderPreview | null>(null);

	const recorderRef = useRef<MediaRecorder | null>(null);
	const recordingStreamRef = useRef<MediaStream | null>(null);
	const streamsRef = useRef<MediaStream[]>([]);
	const mixerRef = useRef<AudioMixer | null>(null);
	const compositorRef = useRef<VideoCompositor | null>(null);
	const formatRef = useRef<RecordingFormat | null>(null);
	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const timerRef = useRef<{
		startedAt: number;
		accumulatedMs: number;
		interval: number | null;
	}>({ startedAt: 0, accumulatedMs: 0, interval: null });
	const stoppingRef = useRef(false);
	const videoRef = useRef<Promise<CreatedVideo> | null>(null);
	const takeRef = useRef<Take | null>(null);

	const readElapsedMs = useCallback(() => {
		const timer = timerRef.current;
		return (
			timer.accumulatedMs +
			(timer.startedAt ? performance.now() - timer.startedAt : 0)
		);
	}, []);

	const stopTimer = useCallback(() => {
		const timer = timerRef.current;
		if (timer.interval !== null) window.clearInterval(timer.interval);
		timer.interval = null;
	}, []);

	const startTimer = useCallback(() => {
		const timer = timerRef.current;
		timer.startedAt = performance.now();
		stopTimer();
		timer.interval = window.setInterval(
			() => setElapsedSeconds(Math.floor(readElapsedMs() / 1000)),
			250,
		);
	}, [readElapsedMs, stopTimer]);

	const releaseCapture = useCallback(async () => {
		for (const stream of streamsRef.current)
			for (const track of stream.getTracks()) track.stop();
		streamsRef.current = [];
		recordingStreamRef.current = null;
		compositorRef.current?.stop();
		compositorRef.current = null;
		setPreview(null);
		const mixer = mixerRef.current;
		mixerRef.current = null;
		if (mixer) await mixer.close();
	}, []);

	useEffect(
		() => () => {
			stopTimer();
			void releaseCapture();
			takeRef.current?.uploader?.suspend();
			closeTake(takeRef.current);
		},
		[releaseCapture, stopTimer],
	);

	const beginTake = useCallback(
		(video: Promise<CreatedVideo>, format: RecordingFormat) => {
			const sessionId = newSessionId();
			const take: Take = {
				video,
				sessionId,
				chunks: [],
				bytes: 0,
				waiting: [],
				uploader: null,
				subpath: `video.${format.extension}`,
				uploadFailed: false,
				ready: Promise.resolve(),
				spool: null,
				thumbnailSent: false,
				cleanups: [],
				closed: false,
			};
			const contentType = format.mimeType.split(";")[0] ?? format.mimeType;
			const startedAt = Date.now();

			// The video and the local backup become ready in either order, so the
			// note that ties them together is rewritten from whatever is known.
			let created: CreatedVideo | null = null;
			const saveMeta = () => {
				if (take.closed) return;
				saveRecordingMeta(sessionId, {
					videoId: created?.id ?? null,
					shareUrl: created?.shareUrl ?? null,
					extension: format.extension,
					...dimensionsRef.current,
					startedAt,
					elapsedMs: readElapsedMs(),
				});
			};

			if (navigator.locks?.request) {
				let release: () => void = () => undefined;
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				void navigator.locks
					.request(recordingLockName(sessionId), () => held)
					.catch(() => undefined);
				take.cleanups.push(release);
			}

			if (canUseRecordingSpool()) {
				void RecordingSpool.create({ mimeType: contentType, sessionId })
					.then((spool) => {
						if (take.closed) return void spool.dispose();
						take.spool = spool;
						saveMeta();
						for (const chunk of take.chunks)
							void spool.appendChunk(chunk).catch(() => undefined);
						const heartbeat = window.setInterval(() => {
							void spool.touch();
							saveMeta();
						}, RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS);
						take.cleanups.push(() => window.clearInterval(heartbeat));
					})
					.catch(() => undefined);
			}

			take.ready = (async () => {
				created = await video;
				if (take.closed) return;
				saveMeta();
				const uploadApi = await createUploadApi();
				if (take.closed) return uploadApi.release();
				take.cleanups.push(uploadApi.release);
				const session = await initiateMultipartUpload({
					videoId: created.id,
					contentType,
					subpath: take.subpath,
					api: uploadApi.options,
				});
				if (take.closed) return;
				const uploader = new InstantRecordingUploader({
					videoId: created.id,
					uploadId: session.uploadId,
					mimeType: contentType,
					subpath: take.subpath,
					setUploadStatus: () => undefined,
					sendProgressUpdate: async (uploaded, total) => {
						if (total > 0) setProgress(Math.min(1, uploaded / total));
					},
					onFatalError: () => {
						take.uploadFailed = true;
					},
					api: uploadApi.options,
				});
				take.uploader = uploader;
				let sent = 0;
				for (const chunk of take.waiting) {
					sent += chunk.size;
					uploader.handleChunk(chunk, sent);
				}
				take.waiting = [];
			})().catch(() => {
				take.uploadFailed = true;
			});

			takeRef.current = take;
			return take;
		},
		[readElapsedMs],
	);

	const addChunk = useCallback((take: Take, chunk: Blob) => {
		take.chunks.push(chunk);
		take.bytes += chunk.size;
		if (take.spool)
			void take.spool.appendChunk(chunk).catch(() => {
				take.spool = null;
			});
		if (take.uploadFailed) return;
		if (!take.uploader) {
			take.waiting.push(chunk);
			return;
		}
		try {
			take.uploader.handleChunk(chunk, take.bytes);
		} catch {
			take.uploadFailed = true;
		}
	}, []);

	const sendThumbnail = useCallback(async (take: Take, thumbnail: Blob) => {
		if (take.thumbnailSent || take.closed) return;
		take.thumbnailSent = true;
		try {
			await uploadThumbnail((await take.video).id, thumbnail);
		} catch {
			take.thumbnailSent = false;
		}
	}, []);

	const uploadWhole = useCallback(async (recording: FinishedRecording) => {
		setPhase("uploading");
		setProgress(0);
		setError(null);
		try {
			let video = await (videoRef.current ?? Promise.reject()).catch(
				() => null,
			);
			if (!video) {
				const created = createVideo();
				videoRef.current = created;
				video = await created;
			}
			setShare(video);
			const take = takeRef.current;
			if (!take?.thumbnailSent) {
				const thumbnail = await captureThumbnail(recording.blob);
				if (thumbnail) await uploadThumbnail(video.id, thumbnail);
			}
			await uploadWholeFile({
				videoId: video.id,
				blob: recording.blob,
				subpath: `video.${recording.format.extension}`,
				contentType: recording.blob.type || recording.format.mimeType,
				durationSeconds: recording.durationSeconds,
				width: recording.width,
				height: recording.height,
				seekable: recording.seekable,
				onProgress: setProgress,
			});
			await forgetTake(take);
			setProgress(1);
			setPhase("done");
		} catch (cause) {
			// The server already holds the finished video: an earlier attempt
			// got through even though its answer was lost.
			if (refusedStartStatus(cause) === 409) {
				await forgetTake(takeRef.current);
				setProgress(1);
				setPhase("done");
				return;
			}
			setError(
				cause instanceof Error
					? `Upload failed: ${cause.message}`
					: "Upload failed",
			);
			setPhase("error");
		}
	}, []);

	const finalize = useCallback(
		async (take: Take) => {
			const format = formatRef.current;
			const durationSeconds = Math.max(1, readElapsedMs() / 1000);
			stopTimer();
			await releaseCapture();
			if (!format) return;

			const raw = new Blob(take.chunks, {
				type: format.mimeType.split(";")[0],
			});
			if (raw.size === 0) {
				await forgetTake(take);
				setError("Nothing was recorded.");
				setPhase("error");
				return;
			}

			setPhase("finishing");
			await take.ready;
			if (take.uploader && !take.uploadFailed) {
				try {
					await take.uploader.finalize({
						durationSeconds,
						...dimensionsRef.current,
						subpath: take.subpath,
					});
					await forgetTake(take);
					setProgress(1);
					setPhase("done");
					return;
				} catch (cause) {
					console.warn("Uploading the whole recording instead", cause);
					take.uploader.suspend();
				}
			}

			let blob = raw;
			let seekable = false;
			if (format.extension === "mp4") {
				try {
					blob = await toSeekableMp4(raw);
					seekable = true;
				} catch (cause) {
					console.warn("Keeping the original recording", cause);
				}
			}
			const recording: FinishedRecording = {
				blob,
				fileName: `capture2u-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format.extension}`,
				durationSeconds,
				...dimensionsRef.current,
				format,
				seekable,
			};
			setFinished(recording);
			await uploadWhole(recording);
		},
		[readElapsedMs, releaseCapture, stopTimer, uploadWhole],
	);

	const stop = useCallback(() => {
		const recorder = recorderRef.current;
		if (!recorder || stoppingRef.current) return;
		stoppingRef.current = true;
		if (recorder.state === "recording") {
			timerRef.current.accumulatedMs = readElapsedMs();
			timerRef.current.startedAt = 0;
		}
		if (recorder.state !== "inactive") recorder.stop();
	}, [readElapsedMs]);

	const beginRecorder = useCallback(() => {
		const stream = recordingStreamRef.current;
		const format = formatRef.current;
		const video = videoRef.current;
		if (!stream || !format || !video) throw new Error("Nothing to record");
		const take = beginTake(video, format);
		const recorder = new MediaRecorder(stream, {
			mimeType: format.mimeType,
			videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
			audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
		});
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0 && !take.closed) addChunk(take, event.data);
		};
		recorder.onstop = () => {
			if (recorderRef.current === recorder) void finalize(take);
		};
		recorder.onerror = () => {
			if (recorderRef.current !== recorder) return;
			setError("Recording stopped unexpectedly.");
			stop();
		};
		recorderRef.current = recorder;
		stoppingRef.current = false;
		stopTimer();
		timerRef.current = { startedAt: 0, accumulatedMs: 0, interval: null };
		recorder.start(1000);
		startTimer();
		setElapsedSeconds(0);
		setProgress(0);
		setPhase("recording");

		const videoTrack = stream.getVideoTracks()[0];
		if (videoTrack) {
			const timeout = window.setTimeout(() => {
				void captureTrackThumbnail(videoTrack).then((thumbnail) => {
					if (thumbnail) void sendThumbnail(take, thumbnail);
				});
			}, THUMBNAIL_DELAY_MS);
			take.cleanups.push(() => window.clearTimeout(timeout));
		}
	}, [
		addChunk,
		beginTake,
		finalize,
		sendThumbnail,
		startTimer,
		stop,
		stopTimer,
	]);

	const dropVideo = useCallback(() => {
		const video = videoRef.current;
		videoRef.current = null;
		setShare(null);
		void video
			?.then((created) => deleteVideo(created.id))
			.catch(() => undefined);
	}, []);

	const start = useCallback(
		async (options: RecorderOptions) => {
			setError(null);
			setNotice(null);
			setShare(null);
			setFinished(null);
			setElapsedSeconds(0);
			setProgress(0);
			stoppingRef.current = false;
			timerRef.current = { startedAt: 0, accumulatedMs: 0, interval: null };

			const format = pickRecordingFormat();
			if (!format || !navigator.mediaDevices?.getDisplayMedia) {
				setError(
					"This browser cannot record the screen. Please use Chrome or Edge on a computer.",
				);
				setPhase("error");
				return;
			}
			formatRef.current = format;
			setPhase("starting");

			const video = createVideo();
			videoRef.current = video;
			video.then(
				(created) => {
					if (videoRef.current === video) setShare(created);
				},
				() => undefined,
			);

			try {
				const display = await acquireDisplayStream({
					mode: options.mode,
					systemAudioEnabled: options.systemAudio,
					onSystemAudioFallback: () =>
						setNotice("System audio is not available for this selection."),
				});
				streamsRef.current.push(display);

				let microphone: MediaStream | null = null;
				if (options.microphoneId !== null) {
					try {
						microphone = await acquireMicStream(
							options.microphoneId || undefined,
						);
						streamsRef.current.push(microphone);
					} catch {
						setNotice("Microphone unavailable. Recording without it.");
					}
				}

				const systemAudioTracks = display.getAudioTracks();
				const videoTrack = display.getVideoTracks()[0];
				if (!videoTrack) throw new Error("No screen was selected");
				const tracks: MediaStreamTrack[] = [videoTrack];
				if (microphone || systemAudioTracks.length > 0) {
					const mixer = await createAudioMixer({
						systemAudioTracks,
						micStream: microphone,
					});
					mixerRef.current = mixer;
					tracks.push(...mixer.stream.getAudioTracks());
				}

				const settings = videoTrack.getSettings();
				dimensionsRef.current = {
					width: settings.width,
					height: settings.height,
				};

				const cameraTrack = options.camera?.stream.getVideoTracks()[0];
				const camera =
					options.camera && cameraTrack?.readyState === "live"
						? { track: cameraTrack, position: options.camera.position }
						: null;
				let cameraInVideo = false;
				if (canCompositeVideo()) {
					let compositor: VideoCompositor | null = null;
					try {
						compositor = createVideoCompositor({
							screenTrack: videoTrack,
							camera,
						});
						dimensionsRef.current = await compositor.ready;
						compositorRef.current = compositor;
						tracks[0] = compositor.track;
						cameraInVideo = camera !== null;
					} catch {
						compositor?.stop();
						if (videoTrack.readyState !== "live")
							throw new Error("Screen sharing was stopped");
						if (camera)
							setNotice("The camera could not be added to this recording.");
					}
				}
				setPreview({
					stream: new MediaStream([videoTrack]),
					width: dimensionsRef.current.width ?? settings.width ?? 16,
					height: dimensionsRef.current.height ?? settings.height ?? 9,
					cameraInVideo,
					entireScreen: settings.displaySurface === "monitor",
				});

				recordingStreamRef.current = new MediaStream(tracks);
				videoTrack.addEventListener("ended", stop, { once: true });
				beginRecorder();
			} catch (cause) {
				await releaseCapture();
				dropVideo();
				if (isUserCancellationError(cause)) {
					setPhase("idle");
					return;
				}
				setError(getCaptureErrorMessage(cause, "display"));
				setPhase("error");
			}
		},
		[beginRecorder, dropVideo, releaseCapture, stop],
	);

	const pause = useCallback(() => {
		const recorder = recorderRef.current;
		if (recorder?.state !== "recording") return;
		recorder.pause();
		timerRef.current.accumulatedMs = readElapsedMs();
		timerRef.current.startedAt = 0;
		stopTimer();
		setPhase("paused");
	}, [readElapsedMs, stopTimer]);

	const resume = useCallback(() => {
		const recorder = recorderRef.current;
		if (recorder?.state !== "paused") return;
		recorder.resume();
		startTimer();
		setPhase("recording");
	}, [startTimer]);

	const discard = useCallback(() => {
		const recorder = recorderRef.current;
		recorderRef.current = null;
		if (recorder && recorder.state !== "inactive") recorder.stop();
		stopTimer();
		timerRef.current = { startedAt: 0, accumulatedMs: 0, interval: null };
		void releaseCapture();
		void forgetTake(takeRef.current);
		takeRef.current = null;
		dropVideo();
		setElapsedSeconds(0);
		setNotice(null);
		setError(null);
		setPhase("idle");
	}, [dropVideo, releaseCapture, stopTimer]);

	const restart = useCallback(() => {
		const recorder = recorderRef.current;
		if (!recorder || recorder.state === "inactive" || stoppingRef.current)
			return;
		recorderRef.current = null;
		recorder.stop();
		const previous = takeRef.current;
		takeRef.current = null;
		void forgetTake(previous).then(() => {
			try {
				beginRecorder();
			} catch {
				discard();
				setError("Could not restart the recording. Please start again.");
				setPhase("error");
			}
		});
	}, [beginRecorder, discard]);

	const retryUpload = useCallback(() => {
		if (finished) void uploadWhole(finished);
	}, [finished, uploadWhole]);

	const reset = useCallback(() => {
		videoRef.current = null;
		takeRef.current = null;
		setPhase("idle");
		setError(null);
		setNotice(null);
		setShare(null);
		setFinished(null);
		setElapsedSeconds(0);
		setProgress(0);
	}, []);

	return {
		phase,
		elapsedSeconds,
		progress,
		notice,
		error,
		share,
		finished,
		preview,
		start,
		stop,
		pause,
		resume,
		restart,
		discard,
		retryUpload,
		reset,
	};
}
