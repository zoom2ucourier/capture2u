import type { DetectedDisplayRecordingMode } from "@cap/recorder-core/recorder-constants";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, ButtonAnchor, ButtonLink } from "../components/common/Button";
import { Card } from "../components/common/Card";
import { Alert } from "../components/common/Feedback";
import { Icons } from "../components/common/Icons";
import {
	FloatingControls,
	RecordingControls,
	RecordingDot,
	StreamVideo,
} from "../components/RecordingControls";
import { formatDuration } from "../lib/api";
import { useFloatingWindow } from "../recorder/useFloatingWindow";
import { useRecorder } from "../recorder/useRecorder";

const MODES: {
	value: DetectedDisplayRecordingMode;
	label: string;
	Icon: typeof Icons.Monitor;
}[] = [
	{ value: "fullscreen", label: "Entire screen", Icon: Icons.Monitor },
	{ value: "window", label: "A window", Icon: Icons.AppWindow },
	{ value: "tab", label: "A browser tab", Icon: Icons.PanelTop },
];

const NO_MICROPHONE = "__none__";
const FLOATING_BAR_HEIGHT = 68;
const FLOATING_WIDTH = 380;
const FLOATING_CAMERA_HEIGHT = 285;

export function RecordPage() {
	const recorder = useRecorder();
	const floating = useFloatingWindow();
	const [mode, setMode] = useState<DetectedDisplayRecordingMode>("fullscreen");
	const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
	const [microphoneId, setMicrophoneId] = useState("");
	const [systemAudio, setSystemAudio] = useState(true);
	const [cameraOn, setCameraOn] = useState(false);
	const [cameraError, setCameraError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const devices = await navigator.mediaDevices.enumerateDevices();
				if (!cancelled)
					setMicrophones(
						devices.filter((device) => device.kind === "audioinput"),
					);
			} catch {
				// Device list stays empty; the default microphone is still used.
			}
		};
		void refresh();
		navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
		return () => {
			cancelled = true;
			navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
		};
	}, []);

	useEffect(() => {
		if (!cameraOn) {
			for (const track of cameraStreamRef.current?.getTracks() ?? [])
				track.stop();
			cameraStreamRef.current = null;
			setCameraStream(null);
			if (document.pictureInPictureElement)
				void document.exitPictureInPicture().catch(() => undefined);
			return;
		}
		let cancelled = false;
		navigator.mediaDevices
			.getUserMedia({ video: { width: 640, height: 480 } })
			.then((stream) => {
				if (cancelled) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				cameraStreamRef.current = stream;
				setCameraStream(stream);
				setCameraError(null);
			})
			.catch(() => {
				setCameraError("Camera unavailable. Check the browser permission.");
				setCameraOn(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cameraOn]);

	useEffect(
		() => () => {
			for (const track of cameraStreamRef.current?.getTracks() ?? [])
				track.stop();
			if (document.pictureInPictureElement)
				void document.exitPictureInPicture().catch(() => undefined);
		},
		[],
	);

	const floatCamera = async () => {
		try {
			await cameraVideoRef.current?.requestPictureInPicture();
		} catch {
			setCameraError("This browser cannot float the camera window.");
		}
	};

	const savedRecordingUrl = useMemo(
		() =>
			recorder.finished ? URL.createObjectURL(recorder.finished.blob) : null,
		[recorder.finished],
	);
	useEffect(
		() => () => {
			if (savedRecordingUrl) URL.revokeObjectURL(savedRecordingUrl);
		},
		[savedRecordingUrl],
	);

	const busy = recorder.phase !== "idle" && recorder.phase !== "error";
	const isLive = recorder.phase === "recording" || recorder.phase === "paused";
	const wantsFloating = recorder.phase === "starting" || isLive;
	const { open: openFloating, close: closeFloating } = floating;

	const phase = recorder.phase;
	useEffect(() => {
		if (phase !== "starting" && phase !== "recording" && phase !== "paused")
			closeFloating();
	}, [phase, closeFloating]);

	const showFloating = () =>
		void openFloating({
			width: FLOATING_WIDTH,
			height: FLOATING_BAR_HEIGHT + (cameraStream ? FLOATING_CAMERA_HEIGHT : 0),
		});

	const startRecording = () => {
		void recorder.start({
			mode,
			microphoneId: microphoneId === NO_MICROPHONE ? null : microphoneId,
			systemAudio,
		});
		showFloating();
	};

	const copyLink = async () => {
		if (!recorder.share) return;
		await navigator.clipboard.writeText(recorder.share.url);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="record">
			<div className="page-head">
				<div className="page-head__text">
					<h1 className="page-head__title">New recording</h1>
					<p className="page-head__subtitle">
						Record your screen and share a link.
					</p>
				</div>
			</div>

			{!busy && (
				<Card
					title="Recording setup"
					icon={<Icons.Video />}
					className="record__setup"
				>
					<fieldset className="record__fieldset">
						<legend className="field__label">What to record</legend>
						<div className="option-tiles">
							{MODES.map((option) => (
								<label
									key={option.value}
									className={`option-tile${
										mode === option.value ? " option-tile--selected" : ""
									}`}
								>
									<input
										type="radio"
										name="mode"
										checked={mode === option.value}
										onChange={() => setMode(option.value)}
									/>
									<option.Icon size={22} />
									{option.label}
								</label>
							))}
						</div>
					</fieldset>

					<label className="field">
						<span className="field__label">
							<Icons.Mic size={14} />
							Microphone
						</span>
						<select
							className="form-select"
							value={microphoneId}
							onChange={(event) => setMicrophoneId(event.target.value)}
						>
							<option value="">Default microphone</option>
							{microphones
								.filter((device) => device.deviceId && device.label)
								.map((device) => (
									<option key={device.deviceId} value={device.deviceId}>
										{device.label}
									</option>
								))}
							<option value={NO_MICROPHONE}>No microphone</option>
						</select>
					</label>

					<label className="check">
						<input
							type="checkbox"
							checked={systemAudio}
							onChange={(event) => setSystemAudio(event.target.checked)}
						/>
						Include computer sound (tick "share audio" when the browser asks)
					</label>

					<label className="check">
						<input
							type="checkbox"
							checked={cameraOn}
							onChange={(event) => setCameraOn(event.target.checked)}
						/>
						Show my camera
					</label>
					{cameraOn && (
						<div className="record__camera">
							<StreamVideo
								stream={cameraStream}
								videoRef={cameraVideoRef}
								className="record__camera-preview"
							/>
							{floating.supported ? (
								<p className="field__hint">
									Your camera floats above your other windows with the recording
									controls. It appears in the video when you record your entire
									screen.
								</p>
							) : (
								<div>
									<Button
										size="sm"
										startIcon={<Icons.PictureInPicture size={14} />}
										onClick={() => void floatCamera()}
									>
										Float camera over my screen
									</Button>
									<p className="field__hint">
										The floating camera appears in the video when you record
										your entire screen.
									</p>
								</div>
							)}
						</div>
					)}
					{cameraError && <Alert>{cameraError}</Alert>}
					{recorder.error && <Alert>{recorder.error}</Alert>}

					<div className="record__actions">
						<Button
							variant="primary"
							size="lg"
							startIcon={<Icons.Record size={18} />}
							onClick={startRecording}
						>
							Start recording
						</Button>
						{recorder.phase === "error" &&
							recorder.finished &&
							savedRecordingUrl && (
								<>
									<Button
										size="lg"
										startIcon={<Icons.Refresh />}
										onClick={recorder.retryUpload}
									>
										Retry upload
									</Button>
									<ButtonAnchor
										variant="ghost"
										size="lg"
										startIcon={<Icons.Download />}
										href={savedRecordingUrl}
										download={recorder.finished.fileName}
									>
										Save recording to this computer
									</ButtonAnchor>
								</>
							)}
					</div>
				</Card>
			)}

			{recorder.phase === "starting" && (
				<div className="card record__status">
					<span className="loading-state__spinner" />
					<p>Choose what to share in the browser prompt…</p>
				</div>
			)}

			{isLive && (
				<div className="card record__live">
					<p className="record__timer">
						<RecordingDot recording={recorder.phase === "recording"} />
						{formatDuration(recorder.elapsedSeconds)}
					</p>
					<p className="record__phase">
						{recorder.phase === "paused" ? "Paused" : "Recording"}
					</p>
					{recorder.notice && (
						<p className="record__notice">{recorder.notice}</p>
					)}
					<RecordingControls recorder={recorder} />
					{floating.supported && !floating.floatingWindow ? (
						<Button
							variant="ghost"
							size="sm"
							startIcon={<Icons.PictureInPicture size={14} />}
							onClick={showFloating}
						>
							Show floating controls
						</Button>
					) : (
						<p className="field__hint">
							{floating.floatingWindow
								? "The floating controls stay on top of your other windows. Keep this tab open while you record."
								: "Keep this tab open while you record. You can switch to other windows."}
						</p>
					)}
				</div>
			)}

			{floating.floatingWindow &&
				wantsFloating &&
				createPortal(
					<FloatingControls recorder={recorder} cameraStream={cameraStream} />,
					floating.floatingWindow.document.body,
				)}

			{(recorder.phase === "finishing" ||
				recorder.phase === "uploading" ||
				recorder.phase === "done") && (
				<Card
					title={
						recorder.phase === "done"
							? "Your video is ready"
							: recorder.phase === "uploading"
								? "Uploading your video"
								: "Preparing your video…"
					}
					icon={
						recorder.phase === "done" ? (
							<Icons.CheckCircle className="icon--complete" />
						) : (
							<Icons.Video />
						)
					}
				>
					{recorder.phase === "finishing" && !recorder.share && (
						<div className="record__status">
							<span className="loading-state__spinner" />
						</div>
					)}
					{recorder.share && (
						<div className="field">
							<span className="field__label">Your link</span>
							<span className="record__link">
								<input
									className="form-input"
									readOnly
									value={recorder.share.url}
									aria-label="Share link"
									onFocus={(event) => event.target.select()}
								/>
								<Button
									startIcon={
										copied ? (
											<Icons.Check className="icon--complete" />
										) : (
											<Icons.Link />
										)
									}
									onClick={() => void copyLink()}
								>
									{copied ? "Copied" : "Copy link"}
								</Button>
							</span>
						</div>
					)}
					{recorder.phase === "uploading" && (
						<>
							<progress
								className="progress"
								value={recorder.progress}
								max={1}
							/>
							<p className="field__hint">
								Uploading {Math.round(recorder.progress * 100)}%. Keep this tab
								open until it finishes.
							</p>
						</>
					)}
					{recorder.phase === "done" && recorder.share && (
						<div className="record__actions">
							<ButtonLink
								variant="primary"
								startIcon={<Icons.Play />}
								to={`/v/${recorder.share.id}`}
							>
								Open video
							</ButtonLink>
							<Button startIcon={<Icons.Record />} onClick={recorder.reset}>
								Record another
							</Button>
						</div>
					)}
				</Card>
			)}
		</div>
	);
}
