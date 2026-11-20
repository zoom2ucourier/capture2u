import type { DetectedDisplayRecordingMode } from "@cap/recorder-core/recorder-constants";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatDuration } from "../lib/api";
import { useRecorder } from "../recorder/useRecorder";

const MODES: { value: DetectedDisplayRecordingMode; label: string }[] = [
	{ value: "fullscreen", label: "Entire screen" },
	{ value: "window", label: "A window" },
	{ value: "tab", label: "A browser tab" },
];

const NO_MICROPHONE = "__none__";

export function RecordPage() {
	const recorder = useRecorder();
	const [mode, setMode] = useState<DetectedDisplayRecordingMode>("fullscreen");
	const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
	const [microphoneId, setMicrophoneId] = useState("");
	const [systemAudio, setSystemAudio] = useState(true);
	const [cameraOn, setCameraOn] = useState(false);
	const [cameraError, setCameraError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
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
				if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
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

	const copyLink = async () => {
		if (!recorder.share) return;
		await navigator.clipboard.writeText(recorder.share.url);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="record">
			<h1>New recording</h1>

			{!busy && (
				<div className="card record-setup">
					<fieldset>
						<legend>What to record</legend>
						<div className="row">
							{MODES.map((option) => (
								<label key={option.value} className="choice">
									<input
										type="radio"
										name="mode"
										checked={mode === option.value}
										onChange={() => setMode(option.value)}
									/>
									{option.label}
								</label>
							))}
						</div>
					</fieldset>

					<label className="field">
						Microphone
						<select
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

					<label className="choice">
						<input
							type="checkbox"
							checked={systemAudio}
							onChange={(event) => setSystemAudio(event.target.checked)}
						/>
						Include computer sound (tick "share audio" when the browser asks)
					</label>

					<label className="choice">
						<input
							type="checkbox"
							checked={cameraOn}
							onChange={(event) => setCameraOn(event.target.checked)}
						/>
						Show my camera
					</label>
					{cameraOn && (
						<div className="camera-row">
							<video
								ref={cameraVideoRef}
								className="camera-preview"
								autoPlay
								muted
								playsInline
							/>
							<div>
								<button
									type="button"
									className="button small"
									onClick={() => void floatCamera()}
								>
									Float camera over my screen
								</button>
								<p className="muted small-text">
									The floating camera appears in the video when you record your
									entire screen.
								</p>
							</div>
						</div>
					)}
					{cameraError && <p className="alert">{cameraError}</p>}
					{recorder.error && <p className="alert">{recorder.error}</p>}

					<div className="row">
						<button
							type="button"
							className="button primary"
							onClick={() =>
								void recorder.start({
									mode,
									microphoneId:
										microphoneId === NO_MICROPHONE ? null : microphoneId,
									systemAudio,
								})
							}
						>
							Start recording
						</button>
						{recorder.phase === "error" &&
							recorder.finished &&
							savedRecordingUrl && (
								<>
									<button
										type="button"
										className="button"
										onClick={recorder.retryUpload}
									>
										Retry upload
									</button>
									<a
										className="button ghost"
										href={savedRecordingUrl}
										download={recorder.finished.fileName}
									>
										Save recording to this computer
									</a>
								</>
							)}
					</div>
				</div>
			)}

			{recorder.phase === "starting" && (
				<div className="card">
					<p>Choose what to share in the browser prompt…</p>
				</div>
			)}

			{isLive && (
				<div className="card live">
					<p className="timer">
						<span
							className={
								recorder.phase === "recording" ? "dot recording" : "dot"
							}
						/>
						{formatDuration(recorder.elapsedSeconds)}
						{recorder.phase === "paused" ? " (paused)" : ""}
					</p>
					{recorder.notice && <p className="muted">{recorder.notice}</p>}
					<div className="row">
						{recorder.phase === "recording" ? (
							<button type="button" className="button" onClick={recorder.pause}>
								Pause
							</button>
						) : (
							<button
								type="button"
								className="button"
								onClick={recorder.resume}
							>
								Resume
							</button>
						)}
						<button
							type="button"
							className="button primary"
							onClick={recorder.stop}
						>
							Stop and share
						</button>
					</div>
					<p className="muted small-text">
						Keep this tab open while you record. You can switch to other
						windows.
					</p>
				</div>
			)}

			{(recorder.phase === "finishing" ||
				recorder.phase === "uploading" ||
				recorder.phase === "done") && (
				<div className="card">
					{recorder.phase === "finishing" && <p>Preparing your video…</p>}
					{recorder.share && (
						<>
							<p className="small-text muted">Your link</p>
							<div className="row link-row">
								<input
									readOnly
									value={recorder.share.url}
									aria-label="Share link"
									onFocus={(event) => event.target.select()}
								/>
								<button
									type="button"
									className="button"
									onClick={() => void copyLink()}
								>
									{copied ? "Copied" : "Copy link"}
								</button>
							</div>
						</>
					)}
					{recorder.phase === "uploading" && (
						<>
							<progress value={recorder.progress} max={1} />
							<p className="muted small-text">
								Uploading {Math.round(recorder.progress * 100)}%. Keep this tab
								open until it finishes.
							</p>
						</>
					)}
					{recorder.phase === "done" && recorder.share && (
						<div className="row">
							<Link className="button primary" to={`/v/${recorder.share.id}`}>
								Open video
							</Link>
							<button type="button" className="button" onClick={recorder.reset}>
								Record another
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
