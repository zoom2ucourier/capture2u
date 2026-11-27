import { createServer } from "node:http";

export const AUTH_API_KEY = "e2e-auth-api-key";
export const USER_ID = "00000000-0000-4000-8000-00000000e2e0";
export const CAPTURE_TITLE = "Capture2u E2E Capture Target";

const readBody = async (request) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
};

const readJson = async (request) => {
	const body = await readBody(request);
	return body.length > 0 ? JSON.parse(body.toString("utf8")) : null;
};

const capturePage = () => `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${CAPTURE_TITLE}</title>
		<style>
			body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #f4f7fb; color: #1c3e61; }
			main { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
			button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #2b93ff; background: #fff; color: #1c3e61; }
			#clock { font-variant-numeric: tabular-nums; }
			#secret { display: inline-block; padding: 6px 10px; background: #fff; border: 1px solid #dee5ee; border-radius: 6px; }
			#bar { height: 12px; width: 0; background: #2b93ff; border-radius: 6px; }
		</style>
	</head>
	<body>
		<main>
			<h1>A normal web page</h1>
			<p>Frame <span id="clock">0</span></p>
			<div id="bar"></div>
			<p><button id="target" type="button">Click me</button> <span id="clicks">0</span> clicks</p>
			<p>Account number: <span id="secret">4111 1111 1111 1111</span></p>
		</main>
		<script>
			let frame = 0;
			const clock = document.getElementById("clock");
			const bar = document.getElementById("bar");
			const tick = () => {
				frame += 1;
				clock.textContent = String(frame);
				bar.style.width = (frame % 300) + "px";
				requestAnimationFrame(tick);
			};
			tick();
			let clicks = 0;
			document.getElementById("target").addEventListener("click", () => {
				clicks += 1;
				document.getElementById("clicks").textContent = String(clicks);
			});
		</script>
	</body>
</html>`;

// Plays the uploaded recording back and reports, per sampled frame, how many
// pixels inside each named box match a colour test. That is how the run
// proves page overlays (click ripples, ink) are in the recorded picture.
const analyzePage = () => `<!doctype html>
<html lang="en">
	<head><meta charset="utf-8" /><title>Recording analysis</title></head>
	<body>
		<video id="video" muted playsinline src="/recording/latest"></video>
		<script>
			window.analyze = (boxes) =>
				new Promise((resolve) => {
					const video = document.getElementById("video");
					const canvas = document.createElement("canvas");
					const context = canvas.getContext("2d", { willReadFrequently: true });
					const tests = {
						blue: (r, g, b) => b > 200 && r < 130 && g > 100 && g < 200,
						red: (r, g, b) => r > 200 && g < 120 && b < 120,
						navy: (r, g, b) => r < 70 && g < 100 && b > 60 && b < 140,
					};
					const best = Object.fromEntries(boxes.map((box) => [box.name, 0]));
					const snapshots = {};
					let frames = 0;
					const sample = () => {
						if (video.videoWidth === 0) return;
						canvas.width = video.videoWidth;
						canvas.height = video.videoHeight;
						context.drawImage(video, 0, 0);
						frames += 1;
						for (const box of boxes) {
							const x = Math.round(box.x * canvas.width);
							const y = Math.round(box.y * canvas.height);
							const width = Math.max(1, Math.round(box.width * canvas.width));
							const height = Math.max(1, Math.round(box.height * canvas.height));
							const { data } = context.getImageData(x, y, width, height);
							let count = 0;
							for (let index = 0; index < data.length; index += 4) {
								if (tests[box.test](data[index], data[index + 1], data[index + 2])) count += 1;
							}
							if (count > best[box.name]) {
								best[box.name] = count;
								snapshots[box.name] = canvas.toDataURL("image/png");
							}
						}
					};
					const finish = (reason) => {
						clearInterval(timer);
						resolve({ reason, frames, width: video.videoWidth, height: video.videoHeight, best, snapshots });
					};
					const timer = setInterval(sample, 40);
					video.addEventListener("ended", () => finish("ended"), { once: true });
					video.addEventListener("error", () => finish("error " + (video.error && video.error.message)), { once: true });
					setTimeout(() => finish("timeout"), 60000);
					video.play().catch((error) => finish("play failed " + error.message));
				});
		</script>
	</body>
</html>`;

const consentPage = (approveUrl, cancelUrl) => `<!doctype html>
<html lang="en">
	<head><meta charset="utf-8" /><title>Connect the Capture2u extension</title></head>
	<body>
		<h1>Connect the Capture2u extension?</h1>
		<a id="approve" href="${approveUrl}">Approve</a>
		<a id="cancel" href="${cancelUrl}">Cancel</a>
	</body>
</html>`;

// An in-memory stand-in for the Capture2u Worker's extension contract. It
// deliberately sends no CORS headers: the extension reaches the real Worker
// from a chrome-extension:// origin and relies on its host permissions.
export const startFakeServer = async () => {
	const state = {
		requests: [],
		unauthorized: [],
		bootstrapCalls: 0,
		createBodies: [],
		initiateBodies: [],
		presignBodies: [],
		parts: new Map(),
		completeBodies: [],
		abortBodies: [],
		progressBodies: [],
		deletedVideoIds: [],
		revokeCalls: 0,
		thumbnails: [],
		authStarts: [],
		videoId: `e2e-${Date.now().toString(36)}`,
	};
	let origin = "";

	const json = (response, status, body, headers = {}) => {
		response.writeHead(status, {
			"Content-Type": "application/json",
			...headers,
		});
		response.end(JSON.stringify(body));
	};

	const html = (response, body) => {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(body);
	};

	const requireBearer = (request, response, pathname) => {
		if (request.headers.authorization === `Bearer ${AUTH_API_KEY}`) return true;
		state.unauthorized.push(`${request.method} ${pathname}`);
		json(response, 401, { error: "unauthorized" });
		return false;
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
		const { pathname } = url;
		const method = request.method ?? "GET";
		state.requests.push(`${method} ${pathname}`);

		try {
			if (method === "GET" && pathname === "/capture.html") {
				html(response, capturePage());
				return;
			}

			if (method === "GET" && pathname === "/analyze.html") {
				html(response, analyzePage());
				return;
			}

			if (method === "GET" && pathname === "/recording/latest") {
				const body = Buffer.concat(
					[...state.parts.keys()]
						.sort((left, right) => left - right)
						.map((partNumber) => state.parts.get(partNumber)),
				);
				response.writeHead(200, {
					"Content-Type": state.initiateBodies[0]?.contentType ?? "video/mp4",
					"Content-Length": body.length,
				});
				response.end(body);
				return;
			}

			if (method === "GET" && pathname.startsWith("/v/")) {
				html(
					response,
					`<!doctype html><title>Shared video</title><h1 id="share">Share page for ${pathname.slice(3)}</h1>`,
				);
				return;
			}

			if (method === "GET" && pathname === "/api/extension/auth/start") {
				const redirectUri = url.searchParams.get("redirectUri") ?? "";
				const authState = url.searchParams.get("state") ?? "";
				state.authStarts.push({ redirectUri, state: authState });
				const consent = new URL("/extension/connect", origin);
				consent.searchParams.set("redirectUri", redirectUri);
				consent.searchParams.set("state", authState);
				response.writeHead(302, { Location: consent.toString() });
				response.end();
				return;
			}

			if (method === "GET" && pathname === "/extension/connect") {
				const redirectUri = url.searchParams.get("redirectUri") ?? "";
				const authState = url.searchParams.get("state") ?? "";
				const approved = new URLSearchParams({
					state: authState,
					authApiKey: AUTH_API_KEY,
					userId: USER_ID,
				});
				const denied = new URLSearchParams({
					state: authState,
					error: "access_denied",
				});
				html(
					response,
					consentPage(`${redirectUri}#${approved}`, `${redirectUri}#${denied}`),
				);
				return;
			}

			if (method === "POST" && pathname === "/api/extension/auth/revoke") {
				if (!requireBearer(request, response, pathname)) return;
				state.revokeCalls += 1;
				json(response, 200, { success: true });
				return;
			}

			if (method === "GET" && pathname === "/api/extension/bootstrap") {
				if (!requireBearer(request, response, pathname)) return;
				state.bootstrapCalls += 1;
				json(response, 200, {
					user: { id: USER_ID, email: "e2e@locate2u.com" },
					organization: { id: "locate2u", name: "Locate2u" },
					plan: { isPro: true, maxRecordingSeconds: null },
				});
				return;
			}

			if (
				method === "POST" &&
				pathname === "/api/extension/instant-recordings"
			) {
				if (!requireBearer(request, response, pathname)) return;
				state.createBodies.push(await readJson(request));
				json(response, 200, {
					id: state.videoId,
					shareUrl: `${origin}/v/${state.videoId}`,
					upload: { type: "put", url: "", headers: {} },
				});
				return;
			}

			if (
				method === "POST" &&
				pathname === "/api/extension/instant-recordings/progress"
			) {
				if (!requireBearer(request, response, pathname)) return;
				state.progressBodies.push(await readJson(request));
				json(response, 200, { success: true });
				return;
			}

			if (
				method === "DELETE" &&
				pathname.startsWith("/api/extension/instant-recordings/")
			) {
				if (!requireBearer(request, response, pathname)) return;
				state.deletedVideoIds.push(
					decodeURIComponent(pathname.split("/").pop()),
				);
				json(response, 200, { success: true });
				return;
			}

			if (method === "POST" && pathname === "/api/upload/multipart/initiate") {
				if (!requireBearer(request, response, pathname)) return;
				state.initiateBodies.push(await readJson(request));
				json(response, 200, { uploadId: "upload-e2e" });
				return;
			}

			if (
				method === "POST" &&
				pathname === "/api/upload/multipart/presign-part"
			) {
				if (!requireBearer(request, response, pathname)) return;
				const body = await readJson(request);
				state.presignBodies.push(body);
				json(response, 200, {
					presignedUrl: `${origin}/api/upload/multipart/part/${body.uploadId}/${body.partNumber}?token=signed`,
				});
				return;
			}

			if (
				method === "PUT" &&
				pathname.startsWith("/api/upload/multipart/part/")
			) {
				const partNumber = Number(pathname.split("/").pop());
				const body = await readBody(request);
				state.parts.set(partNumber, body);
				response.writeHead(200, { ETag: `"etag-${partNumber}"` });
				response.end();
				return;
			}

			if (method === "POST" && pathname === "/api/upload/multipart/complete") {
				if (!requireBearer(request, response, pathname)) return;
				state.completeBodies.push(await readJson(request));
				json(response, 200, { success: true });
				return;
			}

			if (method === "POST" && pathname === "/api/upload/multipart/abort") {
				if (!requireBearer(request, response, pathname)) return;
				state.abortBodies.push(await readJson(request));
				json(response, 200, { success: true });
				return;
			}

			if (method === "PUT" && pathname.startsWith("/api/upload/thumbnail/")) {
				if (!requireBearer(request, response, pathname)) return;
				state.thumbnails.push({
					videoId: decodeURIComponent(pathname.split("/").pop()),
					contentType: request.headers["content-type"],
					body: await readBody(request),
				});
				json(response, 200, { success: true });
				return;
			}

			json(response, 404, { error: `Unhandled ${method} ${pathname}` });
		} catch (error) {
			json(response, 500, { error: String(error) });
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	origin = `http://127.0.0.1:${address.port}`;

	return {
		origin,
		state,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
};
