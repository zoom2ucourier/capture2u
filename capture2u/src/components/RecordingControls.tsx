import { type RefObject, useEffect, useRef, useState } from "react";
import { formatDuration } from "../lib/api";
import type { useRecorder } from "../recorder/useRecorder";
import { Button } from "./common/Button";
import { Icons } from "./common/Icons";

type Recorder = ReturnType<typeof useRecorder>;
type Confirming = "restart" | "delete" | null;

export function StreamVideo({
	stream,
	className,
	videoRef,
}: {
	stream: MediaStream | null;
	className: string;
	videoRef?: RefObject<HTMLVideoElement | null>;
}) {
	const localRef = useRef<HTMLVideoElement | null>(null);
	const target = videoRef ?? localRef;

	useEffect(() => {
		if (target.current) target.current.srcObject = stream;
	}, [stream, target]);

	return (
		<video ref={target} className={className} autoPlay muted playsInline />
	);
}

export function RecordingDot({ recording }: { recording: boolean }) {
	return (
		<span
			className={
				recording ? "record__dot record__dot--recording" : "record__dot"
			}
		/>
	);
}

function useConfirming(recorder: Recorder) {
	const [confirming, setConfirming] = useState<Confirming>(null);
	const confirm = () => {
		if (confirming === "restart") recorder.restart();
		if (confirming === "delete") recorder.discard();
		setConfirming(null);
	};
	return { confirming, setConfirming, confirm };
}

function ConfirmRow({
	confirming,
	size,
	onConfirm,
	onCancel,
}: {
	confirming: Exclude<Confirming, null>;
	size: "sm" | "lg";
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<>
			<span className="recording-confirm__question">
				{confirming === "delete"
					? "Delete this recording?"
					: "Start this recording over?"}
			</span>
			<Button variant="danger" size={size} onClick={onConfirm}>
				{confirming === "delete" ? "Delete" : "Start over"}
			</Button>
			<Button size={size} onClick={onCancel}>
				Cancel
			</Button>
		</>
	);
}

export function RecordingControls({ recorder }: { recorder: Recorder }) {
	const { confirming, setConfirming, confirm } = useConfirming(recorder);
	const recording = recorder.phase === "recording";

	if (confirming)
		return (
			<div className="record__actions record__actions--centered">
				<ConfirmRow
					confirming={confirming}
					size="lg"
					onConfirm={confirm}
					onCancel={() => setConfirming(null)}
				/>
			</div>
		);

	return (
		<div className="record__actions record__actions--centered">
			{recording ? (
				<Button size="lg" startIcon={<Icons.Pause />} onClick={recorder.pause}>
					Pause
				</Button>
			) : (
				<Button size="lg" startIcon={<Icons.Play />} onClick={recorder.resume}>
					Resume
				</Button>
			)}
			<Button
				size="lg"
				startIcon={<Icons.Refresh />}
				onClick={() => setConfirming("restart")}
			>
				Restart
			</Button>
			<Button
				variant="danger"
				size="lg"
				startIcon={<Icons.Trash />}
				onClick={() => setConfirming("delete")}
			>
				Delete
			</Button>
			<Button
				variant="primary"
				size="lg"
				startIcon={<Icons.Square />}
				onClick={recorder.stop}
			>
				Stop and share
			</Button>
		</div>
	);
}

export function FloatingControls({
	recorder,
	cameraStream,
}: {
	recorder: Recorder;
	cameraStream: MediaStream | null;
}) {
	const { confirming, setConfirming, confirm } = useConfirming(recorder);
	const recording = recorder.phase === "recording";
	const live = recording || recorder.phase === "paused";

	return (
		<div className="floating">
			{cameraStream && (
				<StreamVideo stream={cameraStream} className="floating__camera" />
			)}
			<div className="floating__bar">
				{!live && (
					<span className="floating__status">
						<span className="loading-state__spinner" />
						Choose what to share…
					</span>
				)}
				{live && confirming && (
					<ConfirmRow
						confirming={confirming}
						size="sm"
						onConfirm={confirm}
						onCancel={() => setConfirming(null)}
					/>
				)}
				{live && !confirming && (
					<>
						<span className="floating__timer">
							<RecordingDot recording={recording} />
							{formatDuration(recorder.elapsedSeconds)}
						</span>
						<span className="floating__actions">
							{recording ? (
								<Button
									iconOnly
									aria-label="Pause"
									title="Pause"
									onClick={recorder.pause}
								>
									<Icons.Pause />
								</Button>
							) : (
								<Button
									iconOnly
									aria-label="Resume"
									title="Resume"
									onClick={recorder.resume}
								>
									<Icons.Play />
								</Button>
							)}
							<Button
								iconOnly
								aria-label="Restart"
								title="Restart"
								onClick={() => setConfirming("restart")}
							>
								<Icons.Refresh />
							</Button>
							<Button
								variant="danger"
								iconOnly
								aria-label="Delete"
								title="Delete"
								onClick={() => setConfirming("delete")}
							>
								<Icons.Trash />
							</Button>
							<Button
								variant="primary"
								startIcon={<Icons.Square size={14} />}
								onClick={recorder.stop}
							>
								Stop
							</Button>
						</span>
					</>
				)}
			</div>
		</div>
	);
}
