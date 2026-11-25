import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { WatchVideo } from "../../shared/types";

export interface PlayerHandle {
	seek: (seconds: number) => void;
	currentTime: () => number;
}

interface PlayerProps {
	ref?: Ref<PlayerHandle>;
	playback: NonNullable<WatchVideo["playback"]>;
	trimStart: number | null;
	trimEnd: number | null;
	speed?: number;
	onFirstPlay?: () => void;
}

export function Player({
	ref,
	playback,
	trimStart,
	trimEnd,
	speed = 1,
	onFirstPlay,
}: PlayerProps) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const start = trimStart ?? 0;
	const end = trimEnd;

	useImperativeHandle(
		ref,
		() => ({
			seek(seconds: number) {
				const element = videoRef.current;
				if (!element) return;
				element.currentTime = Math.max(
					start,
					end === null ? seconds : Math.min(seconds, end),
				);
				void element.play().catch(() => undefined);
			},
			currentTime: () => videoRef.current?.currentTime ?? 0,
		}),
		[start, end],
	);

	useEffect(() => {
		if (videoRef.current) videoRef.current.playbackRate = speed;
	}, [speed]);

	const fragment =
		start > 0 || end !== null
			? `#t=${start}${end !== null ? `,${end}` : ""}`
			: "";

	const keepInside = (element: HTMLVideoElement) => {
		if (element.currentTime < start - 0.05) {
			element.currentTime = start;
			return;
		}
		if (end !== null && element.currentTime >= end) {
			if (!element.paused) element.pause();
			if (element.currentTime > end + 0.05) element.currentTime = end;
		}
	};

	return (
		<video
			ref={videoRef}
			src={`${playback.videoUrl}${fragment}`}
			poster={playback.posterUrl ?? undefined}
			controls
			playsInline
			preload="metadata"
			onLoadedMetadata={(event) => {
				event.currentTarget.playbackRate = speed;
				keepInside(event.currentTarget);
			}}
			onTimeUpdate={(event) => keepInside(event.currentTarget)}
			onSeeking={(event) => keepInside(event.currentTarget)}
			onPlay={(event) => {
				const element = event.currentTarget;
				if (end !== null && element.currentTime >= end - 0.05)
					element.currentTime = start;
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
	);
}
