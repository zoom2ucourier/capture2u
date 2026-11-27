import type {
	BootstrapData,
	ExtensionAuth,
	ExtensionSettings,
	InstantRecordingCreateInput,
	InstantRecordingCreation,
} from "./types";

// A hung request would otherwise leave the recorder UI stuck with no way out
// (the floating bar shows "creating" until the start call settles).
const API_REQUEST_TIMEOUT_MS = 30_000;
const AUTH_CHECK_TIMEOUT_MS = 10_000;

// The Capture2u Worker serves the same extension routes as Cap's web app.
const EXTENSION_HTTP_PREFIX = "/extension";
const THUMBNAIL_UPLOAD_PATH = "/api/upload/thumbnail";
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 30_000;

const ExtensionApiPaths = {
	startAuth: "/auth/start",
	revokeAuth: "/auth/revoke",
	bootstrap: "/bootstrap",
	createInstantRecording: "/instant-recordings",
	updateInstantRecordingProgress: "/instant-recordings/progress",
	deleteInstantRecording: (videoId: string) =>
		`/instant-recordings/${encodeURIComponent(videoId)}` as const,
	saveRecordingPages: (videoId: string) =>
		`/instant-recordings/${encodeURIComponent(videoId)}/pages` as const,
} as const;

const EXTENSION_API_PREFIX = `/api${EXTENSION_HTTP_PREFIX}`;

const extensionApiPath = (path: string) => `${EXTENSION_API_PREFIX}${path}`;

const apiUrl = (settings: ExtensionSettings, path: string) =>
	new URL(path, settings.apiBaseUrl).toString();

const isLocalApi = (url: URL) =>
	["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const checkAuthStartRoute = async (
	settings: ExtensionSettings,
	url: URL,
	redirectUri: string,
) => {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
		});
		if (response.type === "opaqueredirect" || response.status === 302) return;
		if (response.ok) return;
		throw new Error(`${response.status} ${await response.text()}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			isLocalApi(url)
				? `Could not reach Capture2u at ${url.origin}. Start the local server and make sure the Capture2u address in the extension's options is ${settings.apiBaseUrl}. Redirect URI: ${redirectUri}. ${message}`
				: `Could not reach Capture2u at ${url.origin}. Check your connection and try again. (${message})`,
		);
	}
};

// Carries the HTTP status so callers can tell a definitive server answer
// (the request was processed and rejected) from a failure where the request
// may never have arrived.
export class ApiRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message || `Request failed with status ${status}`);
		this.name = "ApiRequestError";
		this.status = status;
	}
}

const requestJson = async <TResponse>({
	settings,
	auth,
	path,
	method,
	body,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	path: string;
	method: "GET" | "POST" | "DELETE";
	body?: unknown;
}) => {
	const response = await fetch(apiUrl(settings, path), {
		method,
		headers: {
			Authorization: `Bearer ${auth.authApiKey}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new ApiRequestError(response.status, await response.text());
	}

	return (await response.json()) as TResponse;
};

export const createAuthStart = async (settings: ExtensionSettings) => {
	const redirectUri = chrome.identity.getRedirectURL();
	const state = crypto.randomUUID();
	const url = new URL(
		apiUrl(settings, extensionApiPath(ExtensionApiPaths.startAuth)),
	);
	url.searchParams.set("redirectUri", redirectUri);
	url.searchParams.set("state", state);

	await checkAuthStartRoute(settings, url, redirectUri);

	return { redirectUri, state, url: url.toString() };
};

export const parseAuthResponse = (responseUrl: string, state: string) => {
	const hash = new URL(responseUrl).hash.slice(1);
	const params = new URLSearchParams(hash);
	if (params.get("state") !== state) {
		throw new Error("Auth state did not match");
	}

	// The consent page's Cancel link redirects back with an error in the
	// fragment instead of a key.
	const error = params.get("error");
	if (error) {
		throw new Error(
			error === "access_denied"
				? "Sign-in was canceled."
				: `Sign-in failed: ${error}`,
		);
	}

	const authApiKey = params.get("authApiKey");
	const userId = params.get("userId");
	if (!authApiKey || !userId) {
		throw new Error("Auth response did not include a token");
	}

	return { authApiKey, userId };
};

export const revokeAuth = (settings: ExtensionSettings, auth: ExtensionAuth) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.revokeAuth),
		method: "POST",
	});

// Capture2u has no paid plans or recording limits, so whatever the server
// reports the client treats every signed-in user as unlimited.
export const fetchBootstrap = async (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
): Promise<BootstrapData> => {
	const bootstrap = await requestJson<BootstrapData>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.bootstrap),
		method: "GET",
	});
	return { ...bootstrap, plan: { isPro: true, maxRecordingSeconds: null } };
};

export const createInstantRecording = ({
	settings,
	auth,
	input,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	input: InstantRecordingCreateInput;
}) =>
	requestJson<InstantRecordingCreation>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.createInstantRecording),
		method: "POST",
		body: input,
	});

export const updateUploadProgress = ({
	settings,
	auth,
	videoId,
	uploaded,
	total,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	videoId: string;
	uploaded: number;
	total: number;
}) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.updateInstantRecordingProgress),
		method: "POST",
		body: {
			videoId,
			uploaded,
			total,
			updatedAt: new Date().toISOString(),
		},
	});

export const deleteInstantRecording = (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
	videoId: string,
) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.deleteInstantRecording(videoId)),
		method: "DELETE",
	});

export const saveRecordingPages = (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
	videoId: string,
	pages: { url: string; title: string | null; at: number }[],
) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.saveRecordingPages(videoId)),
		method: "POST",
		body: { pages },
	});

export const uploadThumbnail = async ({
	settings,
	auth,
	videoId,
	image,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	videoId: string;
	image: Blob;
}) => {
	const response = await fetch(
		apiUrl(settings, `${THUMBNAIL_UPLOAD_PATH}/${encodeURIComponent(videoId)}`),
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.authApiKey}`,
				"Content-Type": "image/jpeg",
			},
			body: image,
			signal: AbortSignal.timeout(THUMBNAIL_UPLOAD_TIMEOUT_MS),
		},
	);

	if (!response.ok) {
		throw new ApiRequestError(response.status, await response.text());
	}
};
