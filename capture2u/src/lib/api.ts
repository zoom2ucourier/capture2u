import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PublicConfig } from "../../shared/types";

let configPromise: Promise<PublicConfig> | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;

export function getConfig() {
	configPromise ??= fetch("/api/config").then((response) => {
		if (!response.ok) throw new Error("Could not load configuration");
		return response.json() as Promise<PublicConfig>;
	});
	return configPromise;
}

export function getSupabase() {
	clientPromise ??= getConfig().then((config) => {
		if (!config.supabaseUrl || !config.supabaseAnonKey)
			throw new Error("Sign-in is not configured yet");
		return createClient(config.supabaseUrl, config.supabaseAnonKey);
	});
	return clientPromise;
}

export async function getAccessToken() {
	const supabase = await getSupabase();
	const { data } = await supabase.auth.getSession();
	return data.session?.access_token ?? null;
}

export class ApiRequestError extends Error {
	readonly status: number;
	readonly code: string;
	readonly reason?: string;

	constructor(status: number, code: string, message?: string, reason?: string) {
		super(message ?? code);
		this.name = "ApiRequestError";
		this.status = status;
		this.code = code;
		this.reason = reason;
	}
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	auth?: "required" | "optional" | "none";
}

export async function api<T>(
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const mode = options.auth ?? "required";
	if (mode !== "none") {
		const token = await getAccessToken().catch(() => null);
		if (token) headers.Authorization = `Bearer ${token}`;
		else if (mode === "required")
			throw new ApiRequestError(401, "unauthorized", "Please sign in");
	}

	const response = await fetch(path, {
		method: options.method ?? (options.body === undefined ? "GET" : "POST"),
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const payload = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (!response.ok)
		throw new ApiRequestError(
			response.status,
			typeof payload.error === "string" ? payload.error : "request_failed",
			typeof payload.message === "string" ? payload.message : undefined,
			typeof payload.reason === "string" ? payload.reason : undefined,
		);
	return payload as T;
}

export function formatDuration(seconds: number | null | undefined) {
	if (!seconds || seconds < 0) return "0:00";
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
		: `${minutes}:${secs}`;
}

export function formatDate(iso: string) {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}
