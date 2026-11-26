import { useCallback, useEffect, useRef, useState } from "react";

interface FloatingWindowSize {
	width: number;
	height: number;
}

interface DocumentPictureInPicture {
	requestWindow(options?: FloatingWindowSize): Promise<Window>;
}

const getFloatingApi = (): DocumentPictureInPicture | null =>
	(
		window as Window & {
			documentPictureInPicture?: DocumentPictureInPicture;
		}
	).documentPictureInPicture ?? null;

const copyStyles = (target: Document) => {
	for (const sheet of Array.from(document.styleSheets)) {
		if (sheet.href) {
			const link = target.createElement("link");
			link.rel = "stylesheet";
			link.href = sheet.href;
			target.head.appendChild(link);
			continue;
		}
		const style = target.createElement("style");
		style.textContent = Array.from(sheet.cssRules)
			.map((rule) => rule.cssText)
			.join("\n");
		target.head.appendChild(style);
	}
};

export function useFloatingWindow() {
	const [floatingWindow, setFloatingWindow] = useState<Window | null>(null);
	const windowRef = useRef<Window | null>(null);
	const wantedRef = useRef(false);
	const openingRef = useRef(false);
	const supported = getFloatingApi() !== null;

	const close = useCallback(() => {
		wantedRef.current = false;
		windowRef.current?.close();
		windowRef.current = null;
		setFloatingWindow(null);
	}, []);

	const open = useCallback(async (size: FloatingWindowSize) => {
		const api = getFloatingApi();
		if (!api) return false;
		wantedRef.current = true;
		if (windowRef.current || openingRef.current) return true;
		openingRef.current = true;
		try {
			const opened = await api.requestWindow(size);
			if (!wantedRef.current) {
				opened.close();
				return false;
			}
			copyStyles(opened.document);
			opened.document.title = "Capture2u";
			opened.document.documentElement.lang = "en";
			opened.document.body.className = "floating-body";
			opened.addEventListener(
				"pagehide",
				() => {
					if (windowRef.current !== opened) return;
					windowRef.current = null;
					setFloatingWindow(null);
				},
				{ once: true },
			);
			windowRef.current = opened;
			setFloatingWindow(opened);
			return true;
		} catch {
			return false;
		} finally {
			openingRef.current = false;
		}
	}, []);

	useEffect(() => () => windowRef.current?.close(), []);

	return { supported, floatingWindow, open, close };
}
