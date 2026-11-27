import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthStart, fetchBootstrap, uploadThumbnail } from "./api";
import type { ExtensionSettings } from "./types";

const auth = { authApiKey: "fixture-key", userId: "account" };
const settings = {
	apiBaseUrl: "https://capture.zoom2u.com",
} as ExtensionSettings;

const signInError = (apiBaseUrl: string) =>
	createAuthStart({ apiBaseUrl } as ExtensionSettings).then(
		() => {
			throw new Error("expected sign-in to fail");
		},
		(error: Error) => error.message,
	);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("sign-in when the auth route can't be reached", () => {
	beforeEach(() => {
		vi.stubGlobal("chrome", {
			identity: { getRedirectURL: () => "https://abc.chromiumapp.org/" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
	});

	it("tells everyone but a local developer to check their connection", async () => {
		for (const apiBaseUrl of [
			"https://capture.zoom2u.com",
			"https://capture.example.com",
		]) {
			const message = await signInError(apiBaseUrl);
			expect(message).toContain(`Could not reach Capture2u at ${apiBaseUrl}`);
			expect(message).toContain("Failed to fetch");
			expect(message).not.toContain("local server");
		}
	});

	it("keeps the local-server hint for a local address", async () => {
		for (const apiBaseUrl of [
			"http://localhost:3000",
			"http://127.0.0.1:3000",
		]) {
			expect(await signInError(apiBaseUrl)).toContain("Start the local server");
		}
	});
});

describe("sign-in handoff", () => {
	it("asks the Capture2u auth route to redirect back to the extension", async () => {
		vi.stubGlobal("chrome", {
			identity: { getRedirectURL: () => "https://abc.chromiumapp.org/" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 302 })),
		);

		const start = await createAuthStart(settings);
		const url = new URL(start.url);

		expect(url.origin + url.pathname).toBe(
			"https://capture.zoom2u.com/api/extension/auth/start",
		);
		expect(url.searchParams.get("redirectUri")).toBe(
			"https://abc.chromiumapp.org/",
		);
		expect(url.searchParams.get("state")).toBe(start.state);
	});
});

describe("plan", () => {
	it("treats every signed-in user as unlimited whatever the server reports", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					user: { id: "account", email: "person@example.invalid" },
					organization: { id: "locate2u", name: "Locate2u" },
					plan: { isPro: false, maxRecordingSeconds: 300 },
				}),
			),
		);

		expect((await fetchBootstrap(settings, auth)).plan).toEqual({
			isPro: true,
			maxRecordingSeconds: null,
		});
	});
});

describe("thumbnail upload", () => {
	it("puts the JPEG on the video's thumbnail route with the bearer key", async () => {
		const request = vi.fn(async () => Response.json({ success: true }));
		vi.stubGlobal("fetch", request);
		const image = new Blob(["jpeg"], { type: "image/jpeg" });

		await uploadThumbnail({ settings, auth, videoId: "video 1", image });

		expect(request).toHaveBeenCalledWith(
			"https://capture.zoom2u.com/api/upload/thumbnail/video%201",
			expect.objectContaining({
				method: "PUT",
				headers: {
					Authorization: "Bearer fixture-key",
					"Content-Type": "image/jpeg",
				},
				body: image,
			}),
		);
	});

	it("rejects when the server refuses the picture", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("too large", { status: 413 })),
		);

		await expect(
			uploadThumbnail({
				settings,
				auth,
				videoId: "video",
				image: new Blob(["jpeg"]),
			}),
		).rejects.toMatchObject({ status: 413 });
	});
});
