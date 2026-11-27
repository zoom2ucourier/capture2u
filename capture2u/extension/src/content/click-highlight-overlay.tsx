import { useEffect, useRef, useState } from "react";

type Ripple = {
	id: number;
	x: number;
	y: number;
};

type ClickHighlightOverlayProps = {
	active: boolean;
};

const OVERLAY_ROOT_ID = "capture2u-recorder-overlay";
// Matches the capture2u-click-ripple animation in overlay.css.
export const CLICK_RIPPLE_DURATION_MS = 600;
// A burst of clicks keeps only the newest few rings on screen.
const MAX_RIPPLES = 6;

const isExtensionControl = (target: EventTarget | null) =>
	target instanceof Element && target.closest(`#${OVERLAY_ROOT_ID}`) !== null;

// Draws a short ripple ring at the pointer on every mouse press while a
// recording is live, so viewers can see where the presenter clicked. The rings
// live in the page (inside the overlay's shadow root), which is what makes
// tab, window and screen captures pick them up.
export function ClickHighlightOverlay({ active }: ClickHighlightOverlayProps) {
	const [ripples, setRipples] = useState<Ripple[]>([]);
	const nextIdRef = useRef(0);

	useEffect(() => {
		if (!active) {
			setRipples([]);
			return;
		}

		const timers = new Set<number>();

		const handlePointerDown = (event: MouseEvent) => {
			// Presses on the recorder's own controls (the bar, the draw canvas)
			// are not clicks on the page being presented.
			if (isExtensionControl(event.target)) return;
			const id = nextIdRef.current;
			nextIdRef.current += 1;
			setRipples((current) => [
				...current.slice(-(MAX_RIPPLES - 1)),
				{ id, x: event.clientX, y: event.clientY },
			]);
			const timer = window.setTimeout(() => {
				timers.delete(timer);
				setRipples((current) => current.filter((ripple) => ripple.id !== id));
			}, CLICK_RIPPLE_DURATION_MS);
			timers.add(timer);
		};

		window.addEventListener("pointerdown", handlePointerDown, {
			capture: true,
			passive: true,
		});

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown, {
				capture: true,
			});
			for (const timer of timers) window.clearTimeout(timer);
			setRipples([]);
		};
	}, [active]);

	if (!active || ripples.length === 0) return null;

	return (
		<>
			{ripples.map((ripple) => (
				<span
					key={ripple.id}
					className="capture2u-click-ripple"
					style={{ left: `${ripple.x}px`, top: `${ripple.y}px` }}
					aria-hidden
				/>
			))}
		</>
	);
}
