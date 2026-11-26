import {
	type CSSProperties,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { WatchVideo } from "../../shared/types";
import { formatDuration } from "../lib/api";
import { Icons } from "./common/Icons";

export interface PlayerHandle {
	seek: (seconds: number) => void;
	currentTime: () => number;
}

interface PlayerProps {
	ref?: Ref<PlayerHandle>;
	playback: NonNullable<WatchVideo["playback"]>;
	trimStart: number | null;
	trimEnd: number | null;
	durationSeconds?: number | null;
	onFirstPlay?: () => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const SPEED_KEY = "capture2u.playbackSpeed";
const HIDE_DELAY_MS = 2500;
const LONG_VIDEO_SECONDS = 300;

const readSavedSpeed = () => {
	try {
		const saved = Number(window.localStorage.getItem(SPEED_KEY));
		return SPEEDS.includes(saved) ? saved : 1;
	} catch {
		return 1;
	}
};

const saveSpeed = (speed: number) => {
	try {
		window.localStorage.setItem(SPEED_KEY, String(speed));
	} catch {
		return;
	}
};

const isTypingTarget = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const isActivatable = (target: EventTarget | null) =>
	target instanceof HTMLElement && ["BUTTON", "A"].includes(target.tagName);

export function Player({
	ref,
	playback,
	trimStart,
	trimEnd,
	durationSeconds,
	onFirstPlay,
}: PlayerProps) {
	const containerRef = useRef<HTMLElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const [started, setStarted] = useState(false);
	const [absoluteTime, setAbsoluteTime] = useState(trimStart ?? 0);
	const [mediaDuration, setMediaDuration] = useState(0);
	const [muted, setMuted] = useState(false);
	const [volume, setVolume] = useState(1);
	const [speed, setSpeed] = useState(readSavedSpeed);
	const [captionsOn, setCaptionsOn] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [controlsVisible, setControlsVisible] = useState(true);

	const start = trimStart ?? 0;
	const fullDuration = mediaDuration || durationSeconds || 0;
	const end = trimEnd ?? fullDuration;
	const total = Math.max(0, end - start);
	const position = Math.min(total, Math.max(0, absoluteTime - start));
	const skipSeconds = total >= LONG_VIDEO_SECONDS ? 10 : 5;
	const hasCaptions = Boolean(playback.captionsUrl);
	const canFloat =
		typeof document !== "undefined" && document.pictureInPictureEnabled;

	const seekTo = useCallback(
		(seconds: number) => {
			const element = videoRef.current;
			if (!element) return;
			const upper = end > start ? end : Number.MAX_SAFE_INTEGER;
			const next = Math.min(upper, Math.max(start, seconds));
			element.currentTime = next;
			setAbsoluteTime(next);
		},
		[start, end],
	);

	useImperativeHandle(
		ref,
		() => ({
			seek(seconds: number) {
				seekTo(seconds);
				void videoRef.current?.play().catch(() => undefined);
			},
			currentTime: () => videoRef.current?.currentTime ?? 0,
		}),
		[seekTo],
	);

	const togglePlay = useCallback(() => {
		const element = videoRef.current;
		if (!element) return;
		if (element.paused) void element.play().catch(() => undefined);
		else element.pause();
	}, []);

	const skip = useCallback(
		(seconds: number) => {
			const element = videoRef.current;
			if (element) seekTo(element.currentTime + seconds);
		},
		[seekTo],
	);

	const toggleMute = useCallback(() => {
		const element = videoRef.current;
		if (!element) return;
		element.muted = !element.muted;
		if (!element.muted && element.volume === 0) element.volume = 1;
	}, []);

	const changeSpeed = useCallback((next: number) => {
		setSpeed(next);
		saveSpeed(next);
	}, []);

	const stepSpeed = useCallback(
		(direction: 1 | -1) => {
			const index = SPEEDS.indexOf(speed) + direction;
			const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index))];
			if (next !== undefined) changeSpeed(next);
		},
		[speed, changeSpeed],
	);

	const toggleCaptions = useCallback(() => {
		const track = videoRef.current?.textTracks[0];
		if (!track) return;
		const next = track.mode !== "showing";
		track.mode = next ? "showing" : "hidden";
		setCaptionsOn(next);
	}, []);

	const toggleFullscreen = useCallback(() => {
		if (document.fullscreenElement) {
			void document.exitFullscreen().catch(() => undefined);
			return;
		}
		void containerRef.current?.requestFullscreen().catch(() => undefined);
	}, []);

	const toggleFloat = useCallback(() => {
		if (document.pictureInPictureElement) {
			void document.exitPictureInPicture().catch(() => undefined);
			return;
		}
		void videoRef.current?.requestPictureInPicture().catch(() => undefined);
	}, []);

	const showControls = useCallback(() => {
		setControlsVisible(true);
		if (hideTimerRef.current !== null)
			window.clearTimeout(hideTimerRef.current);
		hideTimerRef.current = window.setTimeout(() => {
			const element = videoRef.current;
			const focusInside = containerRef.current?.contains(
				document.activeElement,
			);
			if (element && !element.paused && !focusInside) setControlsVisible(false);
		}, HIDE_DELAY_MS);
	}, []);

	useEffect(
		() => () => {
			if (hideTimerRef.current !== null)
				window.clearTimeout(hideTimerRef.current);
		},
		[],
	);

	useEffect(() => {
		if (videoRef.current) videoRef.current.playbackRate = speed;
	}, [speed]);

	useEffect(() => {
		const onChange = () =>
			setFullscreen(document.fullscreenElement === containerRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			const key = event.key.toLowerCase();
			if (key === " " && isActivatable(event.target)) return;
			const actions: Record<string, () => void> = {
				" ": togglePlay,
				k: togglePlay,
				arrowleft: () => skip(-skipSeconds),
				arrowright: () => skip(skipSeconds),
				j: () => skip(-skipSeconds),
				l: () => skip(skipSeconds),
				m: toggleMute,
				f: toggleFullscreen,
				c: toggleCaptions,
				">": () => stepSpeed(1),
				"<": () => stepSpeed(-1),
			};
			const action = actions[key];
			if (!action) return;
			event.preventDefault();
			action();
			showControls();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [
		togglePlay,
		skip,
		skipSeconds,
		toggleMute,
		toggleFullscreen,
		toggleCaptions,
		stepSpeed,
		showControls,
	]);

	const fragment =
		start > 0 || trimEnd !== null
			? `#t=${start}${trimEnd !== null ? `,${trimEnd}` : ""}`
			: "";

	const keepInside = (element: HTMLVideoElement) => {
		if (element.currentTime < start - 0.05) {
			element.currentTime = start;
			return;
		}
		if (trimEnd !== null && element.currentTime >= trimEnd) {
			if (!element.paused) element.pause();
			if (element.currentTime > trimEnd + 0.05) element.currentTime = trimEnd;
		}
	};

	const track = (element: HTMLVideoElement) => {
		keepInside(element);
		setAbsoluteTime(element.currentTime);
	};

	const progress = total > 0 ? (position / total) * 100 : 0;
	const volumeLevel = muted ? 0 : volume;

	return (
		<section
			ref={containerRef}
			aria-label="Video player"
			className={`player${controlsVisible || !playing ? "" : " player--idle"}`}
			onPointerMove={showControls}
			onPointerDown={showControls}
			onFocus={showControls}
		>
			<video
				ref={videoRef}
				className="player__video"
				src={`${playback.videoUrl}${fragment}`}
				poster={playback.posterUrl ?? undefined}
				playsInline
				preload="metadata"
				tabIndex={-1}
				onClick={togglePlay}
				onDoubleClick={toggleFullscreen}
				onLoadedMetadata={(event) => {
					const element = event.currentTarget;
					element.playbackRate = speed;
					if (Number.isFinite(element.duration))
						setMediaDuration(element.duration);
					keepInside(element);
				}}
				onDurationChange={(event) => {
					const { duration } = event.currentTarget;
					if (Number.isFinite(duration)) setMediaDuration(duration);
				}}
				onTimeUpdate={(event) => track(event.currentTarget)}
				onSeeking={(event) => track(event.currentTarget)}
				onVolumeChange={(event) => {
					setMuted(event.currentTarget.muted);
					setVolume(event.currentTarget.volume);
				}}
				onPause={() => {
					setPlaying(false);
					setControlsVisible(true);
				}}
				onPlay={(event) => {
					const element = event.currentTarget;
					if (trimEnd !== null && element.currentTime >= trimEnd - 0.05)
						element.currentTime = start;
					setPlaying(true);
					setStarted(true);
					showControls();
					onFirstPlay?.();
				}}
			>
				<track
					kind="captions"
					srcLang="en"
					label="Captions"
					src={playback.captionsUrl ?? undefined}
				/>
			</video>

			{!playing && (
				<button
					type="button"
					className="player__big-play"
					aria-label={started ? "Resume" : "Play"}
					onClick={togglePlay}
				>
					<Icons.Play size={30} />
				</button>
			)}

			<div className="player__controls">
				<input
					className="player__seek"
					type="range"
					min={0}
					max={total || 1}
					step={0.1}
					value={position}
					aria-label="Seek"
					aria-valuetext={`${formatDuration(position)} of ${formatDuration(total)}`}
					style={{ "--player-progress": `${progress}%` } as CSSProperties}
					onChange={(event) => seekTo(start + Number(event.target.value))}
				/>
				<div className="player__row">
					<button
						type="button"
						className="player__button"
						aria-label={playing ? "Pause" : "Play"}
						title={playing ? "Pause (K)" : "Play (K)"}
						onClick={togglePlay}
					>
						{playing ? <Icons.Pause size={18} /> : <Icons.Play size={18} />}
					</button>
					<button
						type="button"
						className="player__button player__skip"
						aria-label={`Back ${skipSeconds} seconds`}
						title={`Back ${skipSeconds} seconds (←)`}
						onClick={() => skip(-skipSeconds)}
					>
						<Icons.RotateCcw size={22} />
						<span className="player__skip-label">{skipSeconds}</span>
					</button>
					<button
						type="button"
						className="player__button player__skip"
						aria-label={`Forward ${skipSeconds} seconds`}
						title={`Forward ${skipSeconds} seconds (→)`}
						onClick={() => skip(skipSeconds)}
					>
						<Icons.RotateCw size={22} />
						<span className="player__skip-label">{skipSeconds}</span>
					</button>
					<button
						type="button"
						className="player__button"
						aria-label={muted ? "Unmute" : "Mute"}
						title={muted ? "Unmute (M)" : "Mute (M)"}
						onClick={toggleMute}
					>
						{volumeLevel === 0 ? (
							<Icons.VolumeX size={18} />
						) : (
							<Icons.Volume size={18} />
						)}
					</button>
					<input
						className="player__volume"
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={volumeLevel}
						aria-label="Volume"
						style={
							{
								"--player-progress": `${volumeLevel * 100}%`,
							} as CSSProperties
						}
						onChange={(event) => {
							const element = videoRef.current;
							if (!element) return;
							element.volume = Number(event.target.value);
							element.muted = element.volume === 0;
						}}
					/>
					<span className="player__time">
						{formatDuration(position)} / {formatDuration(total)}
					</span>
					<span className="player__spacer" />
					<select
						className="player__speed"
						aria-label="Playback speed"
						title="Playback speed"
						value={speed}
						onChange={(event) => changeSpeed(Number(event.target.value))}
					>
						{SPEEDS.map((value) => (
							<option key={value} value={value}>
								{value}x
							</option>
						))}
					</select>
					{hasCaptions && (
						<button
							type="button"
							className={`player__button${captionsOn ? " player__button--on" : ""}`}
							aria-label="Captions"
							aria-pressed={captionsOn}
							title="Captions (C)"
							onClick={toggleCaptions}
						>
							<Icons.Captions size={18} />
						</button>
					)}
					{canFloat && (
						<button
							type="button"
							className="player__button player__button--float"
							aria-label="Picture in picture"
							title="Picture in picture"
							onClick={toggleFloat}
						>
							<Icons.PictureInPicture size={18} />
						</button>
					)}
					<button
						type="button"
						className="player__button"
						aria-label={fullscreen ? "Exit full screen" : "Full screen"}
						title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
						onClick={toggleFullscreen}
					>
						{fullscreen ? (
							<Icons.Minimize size={18} />
						) : (
							<Icons.Maximize size={18} />
						)}
					</button>
				</div>
			</div>
		</section>
	);
}
