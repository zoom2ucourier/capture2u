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
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getAccessToken } from "../lib/api";
import {
	type BubblePositionRef,
	type CameraCompositor,
	canCompositeCamera,
	createCameraCompositor,
} from "./cameraCompositor";
import {
	captureThumbnail,
	pickRecordingFormat,
	type RecordingFormat,
	toSeekableMp4,
} from "./media";

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
}

const VIDEO_BITS_PER_SECOND = 2_500_000;
const AUDIO_BITS_PER_SECOND = 128_000;

export function useRecorder() {
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [progress, setProgress] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [share, setShare] = useState<{ id: string; url: string } | null>(null);
	const [finished, setFinished] = useState<FinishedRecording | null>(null);
	const [preview, setPreview] = useState<RecorderPreview | null>(null);

	const recorderRef = useRef<MediaRecorder | null>(null);
	const recordingStreamRef = useRef<MediaStream | null>(null);
	const streamsRef = useRef<MediaStream[]>([]);
	const mixerRef = useRef<AudioMixer | null>(null);
	const compositorRef = useRef<CameraCompositor | null>(null);
	const formatRef = useRef<RecordingFormat | null>(null);
	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const timerRef = useRef<{
		startedAt: number;
		accumulatedMs: number;
		interval: number | null;
	}>({ startedAt: 0, accumulatedMs: 0, interval: null });
	const stoppingRef = useRef(false);

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
		},
		[releaseCapture, stopTimer],
	);

	const upload = useCallback(async (recording: FinishedRecording) => {
		setPhase("uploading");
		setProgress(0);
		setError(null);
		try {
			const created = await api<{ id: string; shareUrl: string }>(
				"/api/videos",
				{ method: "POST", body: {} },
			);
			setShare({ id: created.id, url: created.shareUrl });

			const authToken = (await getAccessToken()) ?? undefined;
			const thumbnail = await captureThumbnail(recording.blob);
			if (thumbnail && authToken) {
				await fetch(`/api/upload/thumbnail/${created.id}`, {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${authToken}`,
						"Content-Type": "image/jpeg",
					},
					body: thumbnail,
				}).catch(() => undefined);
			}

			const subpath = `video.${recording.format.extension}`;
			const apiOptions = { authToken };
			const session = await initiateMultipartUpload({
				videoId: created.id,
				contentType: recording.blob.type || recording.format.mimeType,
				subpath,
				api: apiOptions,
			});
			const uploader = new InstantRecordingUploader({
				videoId: created.id,
				uploadId: session.uploadId,
				mimeType: recording.blob.type || recording.format.mimeType,
				subpath,
				setUploadStatus: () => undefined,
				sendProgressUpdate: async (uploaded, total) => {
					if (total > 0) setProgress(Math.min(1, uploaded / total));
				},
				api: apiOptions,
			});
			await uploader.finalize({
				finalBlob: recording.blob,
				durationSeconds: recording.durationSeconds,
				width: recording.width,
				height: recording.height,
				subpath,
			});
			setProgress(1);
			setPhase("done");
		} catch (cause) {
			setError(
				cause instanceof Error
					? `Upload failed: ${cause.message}`
					: "Upload failed",
			);
			setPhase("error");
		}
	}, []);

	const finalize = useCallback(
		async (chunks: Blob[]) => {
			const format = formatRef.current;
			const durationSeconds = Math.max(1, readElapsedMs() / 1000);
			stopTimer();
			await releaseCapture();
			if (!format) return;

			const raw = new Blob(chunks, {
				type: format.mimeType.split(";")[0],
			});
			if (raw.size === 0) {
				setError("Nothing was recorded.");
				setPhase("error");
				return;
			}

			setPhase("finishing");
			let blob = raw;
			if (format.extension === "mp4") {
				try {
					blob = await toSeekableMp4(raw);
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
			};
			setFinished(recording);
			await upload(recording);
		},
		[readElapsedMs, releaseCapture, stopTimer, upload],
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
		if (!stream || !format) throw new Error("Nothing to record");
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, {
			mimeType: format.mimeType,
			videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
			audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
		});
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			if (recorderRef.current === recorder) void finalize(chunks);
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
		setPhase("recording");
	}, [finalize, startTimer, stop, stopTimer]);

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
				let cameraInVideo = false;
				if (
					options.camera &&
					cameraTrack?.readyState === "live" &&
					canCompositeCamera()
				) {
					try {
						const compositor = createCameraCompositor({
							screenTrack: videoTrack,
							cameraTrack,
							position: options.camera.position,
						});
						compositorRef.current = compositor;
						tracks[0] = compositor.track;
						cameraInVideo = true;
					} catch {
						setNotice("The camera could not be added to this recording.");
					}
				}
				setPreview({
					stream: new MediaStream([videoTrack]),
					width: settings.width ?? 16,
					height: settings.height ?? 9,
					cameraInVideo,
					entireScreen: settings.displaySurface === "monitor",
				});

				recordingStreamRef.current = new MediaStream(tracks);
				videoTrack.addEventListener("ended", stop, { once: true });
				beginRecorder();
			} catch (cause) {
				await releaseCapture();
				if (isUserCancellationError(cause)) {
					setPhase("idle");
					return;
				}
				setError(getCaptureErrorMessage(cause, "display"));
				setPhase("error");
			}
		},
		[beginRecorder, releaseCapture, stop],
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
		setElapsedSeconds(0);
		setNotice(null);
		setError(null);
		setPhase("idle");
	}, [releaseCapture, stopTimer]);

	const restart = useCallback(() => {
		const recorder = recorderRef.current;
		if (!recorder || recorder.state === "inactive" || stoppingRef.current)
			return;
		recorderRef.current = null;
		recorder.stop();
		try {
			beginRecorder();
		} catch {
			discard();
			setError("Could not restart the recording. Please start again.");
			setPhase("error");
		}
	}, [beginRecorder, discard]);

	const retryUpload = useCallback(() => {
		if (finished) void upload(finished);
	}, [finished, upload]);

	const reset = useCallback(() => {
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
