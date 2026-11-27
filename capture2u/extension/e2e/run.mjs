import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
	AUTH_API_KEY,
	CAPTURE_TITLE,
	startFakeServer,
	USER_ID,
} from "./fake-server.mjs";

// End-to-end check of the built extension in a real browser against an
// in-memory stand-in for the Capture2u Worker. Run `npm run build` first.
//
//   C2U_E2E_BROWSER=chrome    installed Google Chrome (default when present)
//   C2U_E2E_BROWSER=chromium  Playwright's Chromium (npx playwright install chromium)
//   C2U_E2E_HEADED=1          show the browser window
//   C2U_E2E_ONLY=picture      run only the second pass (recorded picture)

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, "../dist");
const outputDir = path.join(here, ".output");

const SETTINGS_KEY = "capture2u-settings";
const AUTH_KEY = "capture2u-auth";
const RECORDING_STATE_KEY = "capture2u-recording-state";
const OVERLAY_ROOT_ID = "capture2u-recorder-overlay";
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

const chromeCandidates = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
].filter(Boolean);
const installedChrome = chromeCandidates.find((candidate) =>
	existsSync(candidate),
);
const browserChoice =
	process.env.C2U_E2E_BROWSER ?? (installedChrome ? "chrome" : "chromium");
const headless = !process.env.C2U_E2E_HEADED;

// Chrome derives an extension's id from the manifest key when there is one,
// and otherwise from an unpacked extension's absolute path (on Windows the
// UTF-16 path with an upper-case drive letter).
const manifestKey = existsSync(path.join(extensionPath, "manifest.json"))
	? JSON.parse(readFileSync(path.join(extensionPath, "manifest.json"), "utf8"))
			.key
	: undefined;
const unpackedExtensionId = createHash("sha256")
	.update(
		manifestKey
			? Buffer.from(manifestKey, "base64")
			: process.platform === "win32"
				? Buffer.from(
						extensionPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
						"utf16le",
					)
				: extensionPath,
	)
	.digest("hex")
	.slice(0, 32)
	.replace(/[0-9a-f]/g, (digit) =>
		String.fromCharCode(97 + Number.parseInt(digit, 16)),
	);

const checks = [];
const check = (name, ok, detail = "") => {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
	return Boolean(ok);
};
const note = (message) => console.log(`      ${message}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, { timeout = 15_000, interval = 150 } = {}) => {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await probe();
			if (last) return last;
		} catch (error) {
			last = undefined;
			if (Date.now() + interval >= deadline) throw error;
		}
		await sleep(interval);
	}
	return last || null;
};

const launch = async (args) => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "capture2u-e2e-"));
	const useInstalled = browserChoice === "chrome";
	if (useInstalled && !installedChrome) {
		throw new Error("Google Chrome was not found. Set CHROME_PATH.");
	}
	// Branded Chrome ignores --load-extension, so it loads the unpacked
	// extension over the DevTools protocol instead.
	const context = await chromium.launchPersistentContext(
		userDataDir,
		useInstalled
			? {
					executablePath: installedChrome,
					headless,
					viewport: { width: 1280, height: 720 },
					ignoreDefaultArgs: ["--disable-extensions"],
					args: ["--enable-unsafe-extension-debugging", ...args],
				}
			: {
					channel: "chromium",
					headless,
					viewport: { width: 1280, height: 720 },
					args: [
						`--disable-extensions-except=${extensionPath}`,
						`--load-extension=${extensionPath}`,
						...args,
					],
				},
	);
	if (useInstalled) {
		const browser = context.browser();
		if (!browser) throw new Error("Chrome did not expose a DevTools session");
		const session = await browser.newBrowserCDPSession();
		await session.send("Extensions.loadUnpacked", { path: extensionPath });
		await session.detach();
	}
	return {
		context,
		version: context.browser()?.version() ?? "unknown",
		cleanup: async () => {
			await context.close().catch(() => undefined);
			await rm(userDataDir, { recursive: true, force: true }).catch(
				() => undefined,
			);
		},
	};
};

const getServiceWorker = async (context) => {
	const find = () =>
		context
			.serviceWorkers()
			.find((worker) => worker.url().endsWith("assets/service-worker.js"));
	return (
		find() ??
		(await context.waitForEvent("serviceworker", {
			predicate: (worker) => worker.url().endsWith("assets/service-worker.js"),
			timeout: 20_000,
		}))
	);
};

const storageGet = async (context, area, key) => {
	const worker = await getServiceWorker(context);
	return worker.evaluate(
		([areaName, storageKey]) =>
			new Promise((resolve) => {
				chrome.storage[areaName].get([storageKey], (items) =>
					resolve(items?.[storageKey] ?? null),
				);
			}),
		[area, key],
	);
};

const storageSet = async (context, area, items) => {
	const worker = await getServiceWorker(context);
	await worker.evaluate(
		([areaName, values]) =>
			new Promise((resolve) => {
				chrome.storage[areaName].set(values, () => resolve(null));
			}),
		[area, items],
	);
};

const recordingPhase = async (context) =>
	(await storageGet(context, "session", RECORDING_STATE_KEY))?.status?.phase ??
	null;

// The overlay lives in a closed shadow root, which page script and Playwright
// locators cannot enter. The DevTools protocol can, so elements are found and
// measured there and then driven with real mouse input.
const queryOverlay = async (page, predicate) => {
	const session = await page.context().newCDPSession(page);
	try {
		const { root } = await session.send("DOM.getDocument", {
			depth: -1,
			pierce: true,
		});
		const matches = [];
		const visit = (node, insideOverlay) => {
			const attributes = {};
			const list = node.attributes ?? [];
			for (let index = 0; index < list.length; index += 2) {
				attributes[list[index]] = list[index + 1];
			}
			const inside = insideOverlay || attributes.id === OVERLAY_ROOT_ID;
			if (inside && predicate(attributes, node)) {
				matches.push({ backendNodeId: node.backendNodeId, attributes });
			}
			for (const child of node.children ?? []) visit(child, inside);
			for (const shadow of node.shadowRoots ?? []) visit(shadow, inside);
		};
		visit(root, false);
		const results = [];
		for (const match of matches) {
			try {
				const { model } = await session.send("DOM.getBoxModel", {
					backendNodeId: match.backendNodeId,
				});
				const quad = model.border;
				results.push({
					...match,
					x: (quad[0] + quad[4]) / 2,
					y: (quad[1] + quad[5]) / 2,
					width: model.width,
					height: model.height,
				});
			} catch {
				results.push({ ...match, x: null, y: null, width: 0, height: 0 });
			}
		}
		return results;
	} finally {
		await session.detach().catch(() => undefined);
	}
};

const hasClass = (name) => (attributes) =>
	(attributes.class ?? "").split(/\s+/).includes(name);
const hasLabel = (label) => (attributes) => attributes["aria-label"] === label;

const openDock = async (page) => {
	const [badge] = await queryOverlay(
		page,
		hasClass("capture2u-recording-badge"),
	);
	if (!badge || badge.x === null) throw new Error("Recording badge not found");
	await page.mouse.move(badge.x, badge.y, { steps: 4 });
	const dock = await waitFor(
		async () =>
			(await queryOverlay(page, hasClass("capture2u-vertical-dock")))[0],
		{ timeout: 5_000 },
	);
	if (!dock) throw new Error("Recording dock did not open");
	return badge;
};

const clickDockButton = async (page, label) => {
	await openDock(page);
	// The dock slides in, so a button is only where it will be clicked once
	// two looks in a row find it in the same place.
	let previous = null;
	const button = await waitFor(
		async () => {
			const [match] = await queryOverlay(page, hasLabel(label));
			if (!match || match.x === null) return null;
			const settled =
				previous !== null &&
				Math.abs(previous.x - match.x) < 0.5 &&
				Math.abs(previous.y - match.y) < 0.5;
			previous = match;
			return settled ? match : null;
		},
		{ timeout: 5_000, interval: 120 },
	);
	if (!button) throw new Error(`Dock button "${label}" not found`);
	await page.mouse.move(button.x, button.y, { steps: 3 });
	await page.mouse.click(button.x, button.y);
};

const screenshot = async (page, name) => {
	const file = path.join(outputDir, name);
	await page.screenshot({ path: file }).catch((error) => {
		note(`screenshot ${name} failed: ${error.message}`);
	});
	return file;
};

const jpegSize = (buffer) => {
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) return null;
		const marker = buffer[offset + 1];
		const length = buffer.readUInt16BE(offset + 2);
		if (
			marker >= 0xc0 &&
			marker <= 0xcf &&
			![0xc4, 0xc8, 0xcc].includes(marker)
		) {
			return {
				height: buffer.readUInt16BE(offset + 5),
				width: buffer.readUInt16BE(offset + 7),
			};
		}
		offset += 2 + length;
	}
	return null;
};

const sendFromExtensionPage = (extensionPage, message) =>
	extensionPage.evaluate(
		(payload) =>
			new Promise((resolve) => {
				chrome.runtime.sendMessage(payload, (response) =>
					resolve(
						response ?? { ok: false, error: chrome.runtime.lastError?.message },
					),
				);
			}),
		message,
	);

// Chrome's fake camera stands in for the screen whenever fake devices are on,
// so the first pass proves the pipeline but not the picture. This pass records
// the real tab (no microphone, no fake devices) and then plays the uploaded
// file back to look for the page, a click ripple and a pen stroke in it.
const verifyRecordedPicture = async () => {
	console.log("\nSecond pass: what is in the recorded picture");
	const server = await startFakeServer();
	const { state } = server;
	const browser = await launch([
		`--allowlisted-extension-id=${unpackedExtensionId}`,
		"--allow-http-screen-capture",
		`--auto-select-desktop-capture-source=${CAPTURE_TITLE}`,
		"--enable-usermedia-screen-capturing",
		"--autoplay-policy=no-user-gesture-required",
	]);
	const { context } = browser;
	try {
		const worker = await getServiceWorker(context);
		const extensionId = new URL(worker.url()).host;
		await storageSet(context, "local", {
			[AUTH_KEY]: { authApiKey: AUTH_API_KEY, userId: USER_ID },
			[SETTINGS_KEY]: {
				apiBaseUrl: server.origin,
				webcam: {
					enabled: false,
					deviceId: null,
					position: "bottom-left",
					size: 230,
					shape: "round",
					mirror: false,
				},
				microphone: { enabled: false, deviceId: null },
				systemAudio: { enabled: false },
				sounds: { enabled: false },
				countdown: { enabled: false, seconds: 3 },
				microphoneWarning: { enabled: false },
			},
		});
		await storageSet(context, "session", {
			"capture2u-shared-ui-state": {
				panelOpen: false,
				readyBarDismissed: false,
				updatedAt: Date.now(),
			},
		});
		const extensionPage = await context.newPage();
		await extensionPage.goto(`chrome-extension://${extensionId}/options.html`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/capture.html`);
		await page.bringToFront();

		const started = await sendFromExtensionPage(extensionPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		});
		const recording = await waitFor(
			async () => (await recordingPhase(context)) === "recording",
			{ timeout: 30_000 },
		);
		if (
			!check(
				"real tab recording starts (no fake devices, no microphone)",
				Boolean(recording),
				JSON.stringify(started).slice(0, 200),
			)
		) {
			return;
		}
		await page.bringToFront();
		await sleep(2000);

		// A burst of presses on an empty part of the page keeps a ripple on
		// screen long enough to land in several recorded frames.
		const ripplePoint = { x: 900, y: 420 };
		await page.mouse.move(ripplePoint.x, ripplePoint.y, { steps: 3 });
		for (let press = 0; press < 12; press += 1) {
			await page.mouse.down();
			await sleep(60);
			await page.mouse.up();
			await sleep(90);
		}
		await sleep(900);

		await clickDockButton(page, "Draw on page");
		const drawCanvas = await waitFor(
			async () =>
				(await queryOverlay(page, hasClass("capture2u-draw-canvas")))[0],
			{ timeout: 5_000 },
		);
		if (!drawCanvas)
			throw new Error("Drawing did not start in the second pass");
		const stroke = { fromX: 500, toX: 900, y: 560 };
		await page.mouse.move(stroke.fromX, stroke.y, { steps: 3 });
		await sleep(600);
		await page.mouse.down();
		for (let x = stroke.fromX; x <= stroke.toX; x += 10) {
			await page.mouse.move(x, stroke.y);
		}
		await page.mouse.up();
		await sleep(1500);
		await screenshot(page, "10-second-pass-drawing.png");

		await sendFromExtensionPage(extensionPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		const completed = await waitFor(
			async () => (await recordingPhase(context)) === "completed",
			{ timeout: 60_000, interval: 250 },
		);
		if (
			!check(
				"real tab recording uploads",
				Boolean(completed) && state.completeBodies.length === 1,
				`${state.parts.size} part(s), ${state.initiateBodies[0]?.contentType}, ${JSON.stringify(state.createBodies[0] ?? {})}`,
			)
		) {
			return;
		}

		const thumbnail = await waitFor(() => state.thumbnails[0], {
			timeout: 10_000,
		});
		if (thumbnail) {
			await writeFile(
				path.join(outputDir, "thumbnail-real-tab.jpg"),
				thumbnail.body,
			);
		}
		const uploaded = Buffer.concat(
			[...state.parts.keys()]
				.sort((left, right) => left - right)
				.map((partNumber) => state.parts.get(partNumber)),
		);
		const extension =
			state.initiateBodies[0]?.subpath === "raw-upload.webm" ? "webm" : "mp4";
		await writeFile(
			path.join(outputDir, `recording-real-tab.${extension}`),
			uploaded,
		);

		const analysisPage = await context.newPage();
		await analysisPage.goto(`${server.origin}/analyze.html`);
		const viewport = { width: 1280, height: 720 };
		const box = (name, test, x, y, width, height) => ({
			name,
			test,
			x: x / viewport.width,
			y: y / viewport.height,
			width: width / viewport.width,
			height: height / viewport.height,
		});
		const analysis = await analysisPage.evaluate(
			(boxes) => window.analyze(boxes),
			[
				box("heading", "navy", 260, 70, 300, 50),
				box("ripple", "blue", ripplePoint.x - 40, ripplePoint.y - 40, 80, 80),
				box("stroke", "red", stroke.fromX, stroke.y - 12, 400, 24),
				box("emptyBlue", "blue", 900, 620, 80, 80),
				box("emptyRed", "red", 500, 640, 400, 24),
			],
		);
		for (const [name, dataUrl] of Object.entries(analysis.snapshots)) {
			await writeFile(
				path.join(outputDir, `recorded-frame-${name}.png`),
				Buffer.from(dataUrl.split(",")[1], "base64"),
			);
		}
		note(`playback: ${JSON.stringify({ ...analysis, snapshots: undefined })}`);
		check(
			"the uploaded recording plays back",
			analysis.frames > 10 && analysis.width > 0,
			`${analysis.width}x${analysis.height}, ${analysis.frames} sampled frames, ${analysis.reason}`,
		);
		check(
			"the recording shows the page itself",
			analysis.best.heading > 200,
			`${analysis.best.heading} heading-coloured pixels`,
		);
		check(
			"click highlight is in the recorded picture",
			analysis.best.ripple > 40 && analysis.best.emptyBlue === 0,
			`${analysis.best.ripple} ripple-coloured pixels at the click, ${analysis.best.emptyBlue} in an untouched area`,
		);
		check(
			"drawing is in the recorded picture",
			analysis.best.stroke > 500 && analysis.best.emptyRed === 0,
			`${analysis.best.stroke} ink-coloured pixels on the stroke, ${analysis.best.emptyRed} in an untouched area`,
		);
	} finally {
		await browser.cleanup();
		await server.close();
	}
};

const runFirstPass = async () => {
	const server = await startFakeServer();
	const { state } = server;
	const browser = await launch([
		`--allowlisted-extension-id=${unpackedExtensionId}`,
		"--allow-http-screen-capture",
		`--auto-select-desktop-capture-source=${CAPTURE_TITLE}`,
		"--enable-usermedia-screen-capturing",
		"--autoplay-policy=no-user-gesture-required",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
	]);
	const { context } = browser;
	console.log(
		`Browser: ${browserChoice} ${browser.version} (${headless ? "headless" : "headed"})`,
	);
	console.log(`Fake Capture2u server: ${server.origin}\n`);

	const pageErrors = [];
	context.on("weberror", (error) => pageErrors.push(String(error.error())));

	try {
		// ---- service worker and manifest ---------------------------------
		const worker = await getServiceWorker(context);
		const extensionId = new URL(worker.url()).host;
		check(
			"service worker registered",
			extensionId.length === 32,
			`id ${extensionId}`,
		);
		check(
			"extension id is the one the manifest key pins",
			extensionId === unpackedExtensionId,
			manifestKey
				? "from the manifest key"
				: "no key: id follows the folder path",
		);
		const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
		check(
			"manifest is branded Capture2u",
			manifest.name === "Capture2u" &&
				manifest.description ===
					"Record your screen and share a link. For Locate2u staff.",
			`${manifest.name} ${manifest.version}`,
		);

		// The first run opens the recorder page; give it a moment, then use it
		// as the extension page that asks Chrome about commands.
		const firstRunPage = await waitFor(
			() =>
				context
					.pages()
					.find((page) => page.url().includes(`${extensionId}/recorder.html`)),
			{ timeout: 10_000 },
		);
		check(
			"install opens the Capture2u recorder page (no welcome/marketing page)",
			Boolean(firstRunPage),
			firstRunPage?.url() ?? "not opened",
		);
		if (firstRunPage) {
			await firstRunPage.waitForLoadState("load").catch(() => undefined);
			await sleep(800);
			await screenshot(firstRunPage, "00-first-run-recorder-page.png");
		}

		await storageSet(context, "local", {
			[SETTINGS_KEY]: {
				apiBaseUrl: server.origin,
				webcam: {
					enabled: false,
					deviceId: null,
					position: "bottom-left",
					size: 230,
					shape: "round",
					mirror: false,
				},
				microphoneWarning: { enabled: false },
			},
		});
		// Closing the first-run panel so the web-page steps start clean.
		await storageSet(context, "session", {
			"capture2u-shared-ui-state": {
				panelOpen: false,
				readyBarDismissed: false,
				updatedAt: Date.now(),
			},
		});

		const extensionPage = await context.newPage();
		await extensionPage.setViewportSize({ width: 332, height: 600 });
		await extensionPage.goto(
			`chrome-extension://${extensionId}/popup-window.html`,
		);
		const signInButton = extensionPage.getByRole("button", {
			name: "Sign in to Capture2u",
		});
		const signedOutVisible = await signInButton
			.waitFor({ state: "visible", timeout: 15_000 })
			.then(
				() => true,
				() => false,
			);
		await sleep(1800);
		await screenshot(extensionPage, "01-popup-signed-out.png");
		const popupText = await extensionPage.evaluate(
			() => document.body.innerText,
		);
		check("popup renders the signed-out view", signedOutVisible);
		check(
			"popup shows Capture2u branding and no Cap wording",
			/Capture2u/.test(popupText) && !/\bCap\b/.test(popupText),
			popupText.replace(/\s+/g, " ").slice(0, 120),
		);
		const brandLogo = await extensionPage.evaluate(() => {
			const logo = document.querySelector('svg[aria-label="Capture2u"]');
			const owner = document.querySelector("img.cap-signin-owner");
			return {
				label: logo?.getAttribute("aria-label") ?? null,
				ownerLoaded:
					owner instanceof HTMLImageElement && owner.naturalWidth > 0,
			};
		});
		check(
			"popup logo is the Capture2u mark with the Locate2u logo",
			brandLogo.label === "Capture2u" && brandLogo.ownerLoaded,
		);

		const commands = await extensionPage.evaluate(() =>
			chrome.commands.getAll(),
		);
		const toggle = commands.find(
			(command) => command.name === "toggle-recording",
		);
		check(
			"keyboard shortcut is registered",
			toggle?.shortcut === "Alt+Shift+S",
			JSON.stringify(toggle ?? null),
		);

		// ---- a normal web page -------------------------------------------
		const page = await context.newPage();
		await page.goto(`${server.origin}/capture.html`);
		await page.bringToFront();
		const handshake = await waitFor(
			() =>
				page.evaluate(() =>
					document.documentElement.getAttribute(
						"data-capture2u-extension-installed",
					),
				),
			{ timeout: 10_000 },
		);
		check("content script runs on a normal web page", handshake === "true");

		const idleRipples = async () =>
			(await queryOverlay(page, hasClass("capture2u-click-ripple"))).length;
		await page.mouse.click(400, 300);
		check(
			"no click highlight while not recording",
			(await idleRipples()) === 0,
		);

		await page.evaluate(() =>
			window.dispatchEvent(new CustomEvent("capture2u-extension-open")),
		);
		const panelFrame = await waitFor(
			() => page.frames().find((frame) => /\/popup\.html#/.test(frame.url())),
			{ timeout: 15_000 },
		);
		check("recorder panel opens inside the page", Boolean(panelFrame));
		if (!panelFrame) throw new Error("The in-page recorder panel never opened");
		await panelFrame
			.getByRole("button", { name: "Sign in to Capture2u" })
			.waitFor({ state: "visible", timeout: 15_000 });
		await sleep(1800);
		await screenshot(page, "02-page-panel-signed-out.png");

		// ---- sign-in through chrome.identity ------------------------------
		const authWindow = context
			.waitForEvent("page", {
				predicate: (candidate) => candidate !== page,
				timeout: 20_000,
			})
			.catch(() => null);
		await panelFrame
			.getByRole("button", { name: "Sign in to Capture2u" })
			.click();
		const consent = await authWindow;
		let signedInThroughFlow = false;
		if (consent) {
			await consent
				.waitForURL(/\/extension\/connect/, { timeout: 15_000 })
				.catch(() => undefined);
			await screenshot(consent, "03-auth-window.png");
			await consent
				.locator("#approve")
				.click({ timeout: 10_000 })
				.catch((error) => note(`approve click failed: ${error.message}`));
			signedInThroughFlow = Boolean(
				await waitFor(
					async () =>
						(await storageGet(context, "local", AUTH_KEY))?.authApiKey ===
						AUTH_API_KEY,
					{ timeout: 15_000 },
				),
			);
		}
		const savedAuth = await storageGet(context, "local", AUTH_KEY);
		check(
			"sign-in handoff through chrome.identity.launchWebAuthFlow",
			signedInThroughFlow && savedAuth?.userId === USER_ID,
			signedInThroughFlow
				? `auth/start got redirectUri ${state.authStarts[0]?.redirectUri}`
				: "auth window could not be driven; continuing with stored auth",
		);
		if (!signedInThroughFlow) {
			await storageSet(context, "local", {
				[AUTH_KEY]: { authApiKey: AUTH_API_KEY, userId: USER_ID },
			});
			await page.reload();
			await page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("capture2u-extension-open")),
			);
		}

		const recorderFrame = await waitFor(
			async () => {
				const frame = page
					.frames()
					.find((candidate) => /\/popup\.html#/.test(candidate.url()));
				if (!frame) return null;
				const visible = await frame
					.getByRole("button", { name: "Start recording" })
					.isVisible()
					.catch(() => false);
				return visible ? frame : null;
			},
			{ timeout: 20_000 },
		);
		check("signed-in recorder panel shows", Boolean(recorderFrame));
		if (!recorderFrame) throw new Error("The recorder panel never signed in");
		await sleep(1200);
		await screenshot(page, "04-page-panel-signed-in.png");
		const panelText = await recorderFrame.evaluate(
			() => document.body.innerText,
		);
		check(
			"panel has no plan badge, upgrade prompt or Cap wording",
			!/\b(Pro|Free|Upgrade|Cap)\b/.test(panelText) &&
				/e2e@locate2u\.com/.test(panelText),
			panelText.replace(/\s+/g, " ").slice(0, 160),
		);
		check(
			"bootstrap called with the bearer key",
			state.bootstrapCalls > 0 && state.unauthorized.length === 0,
			`${state.bootstrapCalls} call(s)`,
		);

		// ---- record -------------------------------------------------------
		await recorderFrame
			.getByRole("button", { name: "Start recording" })
			.click();
		const countdownSeen = await waitFor(
			async () =>
				(await queryOverlay(page, hasClass("capture2u-countdown"))).length >
					0 ||
				(
					await queryOverlay(page, (attributes) =>
						/countdown/.test(attributes.class ?? ""),
					)
				).length > 0,
			{ timeout: 10_000, interval: 100 },
		);
		if (countdownSeen) await screenshot(page, "05-countdown.png");
		const recording = await waitFor(
			async () => (await recordingPhase(context)) === "recording",
			{ timeout: 40_000 },
		);
		check(
			"recording starts from the in-page panel",
			Boolean(recording),
			`phase ${await recordingPhase(context)}`,
		);
		if (!recording) {
			const failed = await storageGet(context, "session", RECORDING_STATE_KEY);
			throw new Error(`Recording did not start: ${JSON.stringify(failed)}`);
		}
		await page.bringToFront();
		const badge = await waitFor(
			async () =>
				(await queryOverlay(page, hasClass("capture2u-recording-badge")))[0],
			{ timeout: 10_000 },
		);
		check("recording badge shows on the page", Boolean(badge));
		await sleep(1500);
		await screenshot(page, "06-recording.png");

		// ---- restart -----------------------------------------------------
		const firstTakeId = state.videoId;
		await clickDockButton(page, "Restart recording");
		await clickDockButton(
			page,
			"Click again to delete this take and start over",
		);
		const restarted = await waitFor(
			async () =>
				state.createBodies.length === 2 &&
				state.videoId !== firstTakeId &&
				(await recordingPhase(context)) === "recording",
			{ timeout: 20_000, interval: 200 },
		);
		check(
			"restart deletes the take and keeps recording as a new video",
			Boolean(restarted) &&
				state.deletedVideoIds.includes(firstTakeId) &&
				state.abortBodies.length === 1,
			JSON.stringify({
				creates: state.createBodies.length,
				deleted: state.deletedVideoIds,
				aborts: state.abortBodies.length,
			}),
		);
		await sleep(1500);

		// ---- click highlights --------------------------------------------
		const target = await page.locator("#target").boundingBox();
		const clickX = target.x + target.width / 2;
		const clickY = target.y + target.height / 2;
		await page.mouse.move(clickX, clickY);
		await page.mouse.down();
		await sleep(180);
		const [ripples] = await Promise.all([
			queryOverlay(page, hasClass("capture2u-click-ripple")),
			screenshot(page, "07-click-highlight.png"),
		]);
		await page.mouse.up();
		const ripple = ripples[0];
		check(
			"click highlight ripple shows at the pointer while recording",
			ripples.length === 1 &&
				Math.abs(ripple.x - clickX) < 1.5 &&
				Math.abs(ripple.y - clickY) < 1.5,
			ripple
				? `ripple centred at ${ripple.x.toFixed(1)},${ripple.y.toFixed(1)}; pressed at ${clickX.toFixed(1)},${clickY.toFixed(1)}`
				: "no ripple",
		);
		const rippleStyle = ripple
			? await (async () => {
					const session = await context.newCDPSession(page);
					try {
						const { nodeIds } = await session.send(
							"DOM.pushNodesByBackendIdsToFrontend",
							{ backendNodeIds: [ripple.backendNodeId] },
						);
						const { computedStyle } = await session.send(
							"CSS.getComputedStyleForNode",
							{ nodeId: nodeIds[0] },
						);
						return Object.fromEntries(
							computedStyle.map((entry) => [entry.name, entry.value]),
						);
					} catch {
						return null;
					} finally {
						await session.detach().catch(() => undefined);
					}
				})()
			: null;
		if (rippleStyle) {
			check(
				"ripple is pointer-events: none",
				rippleStyle["pointer-events"] === "none",
				`position ${rippleStyle.position}`,
			);
		}
		check(
			"the click still reaches the page",
			(await page.locator("#clicks").textContent()) === "1",
		);
		await sleep(900);
		check(
			"ripple clears itself",
			(await queryOverlay(page, hasClass("capture2u-click-ripple"))).length ===
				0,
		);

		await clickDockButton(page, "Highlight clicks");
		const highlightsOff = await waitFor(
			async () =>
				(await storageGet(context, "local", SETTINGS_KEY))?.clickHighlights
					?.enabled === false,
			{ timeout: 5_000 },
		);
		await page.mouse.move(clickX, clickY, { steps: 3 });
		await sleep(700);
		await page.mouse.down();
		const ripplesWhenOff = await queryOverlay(
			page,
			hasClass("capture2u-click-ripple"),
		);
		await page.mouse.up();
		check(
			"click highlights can be switched off from the recording dock",
			Boolean(highlightsOff) && ripplesWhenOff.length === 0,
		);
		await clickDockButton(page, "Highlight clicks");
		await waitFor(
			async () =>
				(await storageGet(context, "local", SETTINGS_KEY))?.clickHighlights
					?.enabled === true,
			{ timeout: 5_000 },
		);

		// ---- drawing ------------------------------------------------------
		await clickDockButton(page, "Draw on page");
		const canvas = await waitFor(
			async () =>
				(await queryOverlay(page, hasClass("capture2u-draw-canvas")))[0],
			{ timeout: 5_000 },
		);
		await page.mouse.move(520, 180, { steps: 4 });
		await sleep(600);
		await page.mouse.down();
		for (let step = 0; step <= 40; step += 1) {
			await page.mouse.move(520 + step * 9, 200 + Math.sin(step / 4) * 60);
		}
		await page.mouse.up();
		await sleep(200);
		const toolbar = await queryOverlay(
			page,
			hasClass("capture2u-draw-toolbar"),
		);
		await screenshot(page, "08-drawing.png");
		check(
			"drawing overlay shows on the page",
			Boolean(canvas) && toolbar.length === 1,
		);
		const [exitDrawing] = await queryOverlay(page, hasLabel("Exit drawing"));
		if (exitDrawing?.x != null)
			await page.mouse.click(exitDrawing.x, exitDrawing.y);
		await waitFor(
			async () =>
				(await queryOverlay(page, hasClass("capture2u-draw-canvas"))).length ===
				0,
			{ timeout: 5_000 },
		);

		// ---- blur ---------------------------------------------------------
		await clickDockButton(page, "Blur content");
		await waitFor(async () => (await recordingPhase(context)) === "paused", {
			timeout: 5_000,
		});
		const secret = await page.locator("#secret").boundingBox();
		await page.mouse.move(
			secret.x + secret.width / 2,
			secret.y + secret.height / 2,
			{ steps: 5 },
		);
		await sleep(300);
		await page.mouse.click(
			secret.x + secret.width / 2,
			secret.y + secret.height / 2,
		);
		const blurred = await page.evaluate(
			() => document.getElementById("secret").style.filter,
		);
		await page.mouse.move(700, 500, { steps: 3 });
		await sleep(300);
		await screenshot(page, "09-blur.png");
		check(
			"blur tool blurs the clicked element",
			blurred === "blur(12px)",
			blurred,
		);
		await page.keyboard.press("Escape");
		const resumed = await waitFor(
			async () => (await recordingPhase(context)) === "recording",
			{ timeout: 5_000 },
		);
		check("recording resumes after blurring", Boolean(resumed));

		// ---- stop and upload ---------------------------------------------
		await sleep(2500);
		await clickDockButton(page, "End recording");
		const completed = await waitFor(
			async () => (await recordingPhase(context)) === "completed",
			{ timeout: 60_000, interval: 250 },
		);
		const finalState = await storageGet(
			context,
			"session",
			RECORDING_STATE_KEY,
		);
		check(
			"recording completes with a share link",
			Boolean(completed) &&
				finalState?.status?.shareUrl === `${server.origin}/v/${state.videoId}`,
			JSON.stringify(finalState?.status ?? null),
		);

		const sharePage = await waitFor(
			() =>
				context
					.pages()
					.find((candidate) => candidate.url().includes(`/v/${state.videoId}`)),
			{ timeout: 10_000 },
		);
		check(
			"the share page opens when the upload finishes",
			Boolean(sharePage),
			sharePage?.url() ?? "",
		);

		const created = state.createBodies[1] ?? {};
		check(
			"instant-recordings body matches Cap's (orgId, size, codecs)",
			state.createBodies.length === 2 &&
				created.orgId === "locate2u" &&
				created.width > 0 &&
				created.height > 0 &&
				typeof created.videoCodec === "string" &&
				created.supportsUploadProgress === true,
			JSON.stringify(created),
		);
		const initiated = state.initiateBodies[1] ?? {};
		check(
			"multipart initiate sent once per take with the raw-upload subpath",
			state.initiateBodies.length === 2 &&
				initiated.videoId === state.videoId &&
				/^raw-upload\.(mp4|webm)$/.test(initiated.subpath ?? ""),
			JSON.stringify(initiated),
		);
		const partNumbers = [...state.parts.keys()].sort((a, b) => a - b);
		const uploaded = Buffer.concat(
			partNumbers.map((partNumber) => state.parts.get(partNumber)),
		);
		check(
			"parts arrive without any CORS headers from the server",
			partNumbers.length >= 1 && uploaded.length > 0,
			`${partNumbers.length} part(s), ${uploaded.length} bytes`,
		);
		const completedBody = state.completeBodies[0] ?? {};
		const completedSize = (completedBody.parts ?? []).reduce(
			(total, part) => total + part.size,
			0,
		);
		check(
			"multipart complete called once with every part",
			state.completeBodies.length === 1 &&
				completedBody.videoId === state.videoId &&
				completedBody.uploadId === "upload-e2e" &&
				completedBody.subpath === initiated.subpath &&
				(completedBody.parts ?? []).length === partNumbers.length &&
				completedSize === uploaded.length &&
				(completedBody.parts ?? []).every((part) =>
					/^etag-\d+$/.test(part.etag),
				) &&
				completedBody.durationInSecs >= 1,
			JSON.stringify({ ...completedBody, parts: completedBody.parts?.length }),
		);
		const isMp4 = uploaded.subarray(4, 8).toString("latin1") === "ftyp";
		const isWebm = uploaded.readUInt32BE(0) === 0x1a45dfa3;
		const extension = isMp4 ? "mp4" : "webm";
		await writeFile(path.join(outputDir, `recording.${extension}`), uploaded);
		check(
			"uploaded bytes are a video file",
			(isMp4 && initiated.subpath === "raw-upload.mp4") ||
				(isWebm && initiated.subpath === "raw-upload.webm"),
			`${extension}, codecs ${created.videoCodec}/${created.audioCodec}`,
		);
		check(
			"upload progress reported",
			state.progressBodies.length >= 1,
			`${state.progressBodies.length} update(s)`,
		);

		const thumbnail = await waitFor(
			() => state.thumbnails.find((entry) => entry.videoId === state.videoId),
			{ timeout: 10_000 },
		);
		const size = thumbnail ? jpegSize(thumbnail.body) : null;
		if (thumbnail) {
			await writeFile(path.join(outputDir, "thumbnail.jpg"), thumbnail.body);
		}
		check(
			"thumbnail uploaded as a JPEG within 1280x720 and 2 MB",
			state.thumbnails.filter((entry) => entry.videoId === state.videoId)
				.length === 1 &&
				thumbnail.contentType === "image/jpeg" &&
				thumbnail.body[0] === 0xff &&
				thumbnail.body[1] === 0xd8 &&
				thumbnail.body.length <= THUMBNAIL_MAX_BYTES &&
				size !== null &&
				size.width <= 1280 &&
				size.height <= 720,
			thumbnail
				? `${size?.width}x${size?.height}, ${thumbnail.body.length} bytes`
				: "no thumbnail request",
		);
		check(
			"every API call carried the bearer key",
			state.unauthorized.length === 0,
			state.unauthorized.join(", "),
		);
		check(
			"only the restarted take was aborted and deleted",
			state.abortBodies.length === 1 &&
				state.deletedVideoIds.length === 1 &&
				state.deletedVideoIds[0] === firstTakeId,
		);

		// ---- extension errors --------------------------------------------
		const errorsPage = await context.newPage();
		const extensionInfo = await errorsPage
			.goto("chrome://extensions/")
			.then(() =>
				errorsPage.evaluate(
					(id) =>
						new Promise((resolve) => {
							chrome.developerPrivate.getExtensionInfo(id, (info) =>
								resolve({
									manifestErrors: info.manifestErrors,
									runtimeErrors: info.runtimeErrors,
									installWarnings: info.installWarnings,
								}),
							);
						}),
					extensionId,
				),
			)
			.catch((error) => ({ unavailable: error.message }));
		if (extensionInfo.unavailable) {
			note(
				`chrome://extensions error list unavailable: ${extensionInfo.unavailable}`,
			);
		} else {
			check(
				"Chrome reports no manifest or runtime errors for the extension",
				extensionInfo.manifestErrors.length === 0 &&
					extensionInfo.runtimeErrors.length === 0 &&
					(extensionInfo.installWarnings ?? []).length === 0,
				JSON.stringify(extensionInfo).slice(0, 600),
			);
		}
		check(
			"no uncaught page errors",
			pageErrors.length === 0,
			pageErrors.join(" | ").slice(0, 400),
		);
	} finally {
		await browser.cleanup();
		await server.close();
	}
};

const main = async () => {
	if (!existsSync(path.join(extensionPath, "manifest.json"))) {
		throw new Error(
			"dist/manifest.json is missing. Run `npm run build` first.",
		);
	}
	await rm(outputDir, { recursive: true, force: true });
	await mkdir(outputDir, { recursive: true });

	if (process.env.C2U_E2E_ONLY !== "picture") {
		await runFirstPass().catch((error) => {
			check("first pass ran to the end", false, error.message.split("\n")[0]);
		});
	}
	await verifyRecordedPicture().catch((error) => {
		check("second pass ran to the end", false, error.message.split("\n")[0]);
	});

	const failed = checks.filter((entry) => !entry.ok);
	console.log(
		`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${outputDir}`,
	);
	if (failed.length > 0) process.exitCode = 1;
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
