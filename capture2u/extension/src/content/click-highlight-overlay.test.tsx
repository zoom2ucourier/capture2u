// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLICK_RIPPLE_DURATION_MS,
	ClickHighlightOverlay,
} from "./click-highlight-overlay";

let root: Root;
let host: HTMLDivElement;
let target: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	host = document.createElement("div");
	target = document.createElement("div");
	document.body.append(host, target);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	target.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const render = (active: boolean) =>
	act(() => root.render(<ClickHighlightOverlay active={active} />));

const press = (clientX: number, clientY: number, element: Element = target) =>
	act(() => {
		element.dispatchEvent(
			new MouseEvent("pointerdown", { bubbles: true, clientX, clientY }),
		);
	});

const ripples = () =>
	Array.from(host.querySelectorAll<HTMLElement>(".capture2u-click-ripple"));

describe("click highlights", () => {
	it("draws a ripple at the pointer for each press while recording", () => {
		render(true);
		press(120, 80);
		press(300, 240);

		expect(
			ripples().map((ripple) => [ripple.style.left, ripple.style.top]),
		).toEqual([
			["120px", "80px"],
			["300px", "240px"],
		]);
	});

	it("removes each ripple once its animation has run", () => {
		render(true);
		press(10, 10);
		act(() => vi.advanceTimersByTime(CLICK_RIPPLE_DURATION_MS - 1));
		expect(ripples()).toHaveLength(1);
		act(() => vi.advanceTimersByTime(1));
		expect(ripples()).toHaveLength(0);
	});

	it("shows nothing when not recording or switched off", () => {
		render(false);
		press(50, 50);
		expect(ripples()).toHaveLength(0);
	});

	it("clears ripples and stops listening when recording ends", () => {
		render(true);
		press(50, 50);
		expect(ripples()).toHaveLength(1);
		render(false);
		expect(ripples()).toHaveLength(0);
		press(60, 60);
		expect(ripples()).toHaveLength(0);
	});

	it("ignores presses on the recorder's own controls", () => {
		render(true);
		target.id = "capture2u-recorder-overlay";
		press(50, 50);
		expect(ripples()).toHaveLength(0);
	});

	it("keeps only the newest rings during a burst of clicks", () => {
		render(true);
		for (let index = 0; index < 10; index += 1) press(index, index);
		const shown = ripples();
		expect(shown).toHaveLength(6);
		expect(shown.at(-1)?.style.left).toBe("9px");
	});

	it("never intercepts the press it highlights", () => {
		render(true);
		const event = new MouseEvent("pointerdown", {
			bubbles: true,
			cancelable: true,
		});
		act(() => {
			target.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(false);
	});
});
