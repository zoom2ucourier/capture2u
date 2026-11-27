import {
	type CSSProperties,
	type PointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { formatDuration } from "../lib/api";
import type { RecorderPreview, useRecorder } from "../recorder/useRecorder";
import {
	BUBBLE_HEIGHT_FRACTION,
	type BubblePosition,
	type BubblePositionRef,
	clampBubblePosition,
} from "../recorder/videoCompositor";
import { Button } from "./common/Button";
import { Icons } from "./common/Icons";

type Recorder = ReturnType<typeof useRecorder>;
type Confirming = "restart" | "delete" | null;

const KEYBOARD_STEP = 0.03;
const KEYBOARD_MOVES: Record<string, BubblePosition> = {
	ArrowLeft: { x: -KEYBOARD_STEP, y: 0 },
	ArrowRight: { x: KEYBOARD_STEP, y: 0 },
	ArrowUp: { x: 0, y: -KEYBOARD_STEP },
	ArrowDown: { x: 0, y: KEYBOARD_STEP },
};

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

type StopHandler = (clickedWindow?: Window | null) => void;

export function RecordingControls({
	recorder,
	onStop,
}: {
	recorder: Recorder;
	onStop: StopHandler;
}) {
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
				onClick={(event) => onStop(event.view as unknown as Window)}
			>
				Stop and share
			</Button>
		</div>
	);
}

function CameraStage({
	preview,
	cameraStream,
	cameraPosition,
}: {
	preview: RecorderPreview;
	cameraStream: MediaStream;
	cameraPosition: BubblePositionRef;
}) {
	const stageRef = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState(() =>
		clampBubblePosition(cameraPosition.current, preview.width, preview.height),
	);

	const move = (next: BubblePosition) => {
		const clamped = clampBubblePosition(next, preview.width, preview.height);
		cameraPosition.current = clamped;
		setPosition(clamped);
	};

	const dragTo = (event: PointerEvent<HTMLButtonElement>) => {
		const bounds = stageRef.current?.getBoundingClientRect();
		if (!bounds || bounds.width === 0 || bounds.height === 0) return;
		move({
			x: (event.clientX - bounds.left) / bounds.width,
			y: (event.clientY - bounds.top) / bounds.height,
		});
	};

	return (
		<div className="floating__stage-area">
			<div
				ref={stageRef}
				className="floating__stage"
				style={
					{
						"--stage-ratio": preview.width / preview.height,
					} as CSSProperties
				}
			>
				{preview.entireScreen ? (
					<div className="floating__screen floating__screen--placeholder">
						Your screen
					</div>
				) : (
					<StreamVideo stream={preview.stream} className="floating__screen" />
				)}
				<button
					type="button"
					className="floating__bubble"
					aria-label="Camera position. Drag to move it, or use the arrow keys."
					title="Drag to move your camera in the video"
					style={{
						left: `${position.x * 100}%`,
						top: `${position.y * 100}%`,
						height: `${BUBBLE_HEIGHT_FRACTION * 100}%`,
					}}
					onPointerDown={(event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
						dragTo(event);
					}}
					onPointerMove={(event) => {
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							dragTo(event);
					}}
					onPointerUp={(event) =>
						event.currentTarget.releasePointerCapture(event.pointerId)
					}
					onKeyDown={(event) => {
						const delta = KEYBOARD_MOVES[event.key];
						if (!delta) return;
						event.preventDefault();
						const from = clampBubblePosition(
							cameraPosition.current,
							preview.width,
							preview.height,
						);
						move({ x: from.x + delta.x, y: from.y + delta.y });
					}}
				>
					<StreamVideo
						stream={cameraStream}
						className="floating__bubble-video"
					/>
				</button>
			</div>
		</div>
	);
}

export function FloatingControls({
	recorder,
	onStop,
	cameraStream,
	cameraPosition,
}: {
	recorder: Recorder;
	onStop: StopHandler;
	cameraStream: MediaStream | null;
	cameraPosition: BubblePositionRef;
}) {
	const { confirming, setConfirming, confirm } = useConfirming(recorder);
	const recording = recorder.phase === "recording";
	const live = recording || recorder.phase === "paused";

	return (
		<div className="floating">
			{cameraStream && recorder.preview?.cameraInVideo && (
				<CameraStage
					preview={recorder.preview}
					cameraStream={cameraStream}
					cameraPosition={cameraPosition}
				/>
			)}
			{cameraStream && !recorder.preview?.cameraInVideo && (
				<div className="floating__selfie">
					<StreamVideo
						stream={cameraStream}
						className="floating__selfie-video"
					/>
				</div>
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
								onClick={(event) => onStop(event.view as unknown as Window)}
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
