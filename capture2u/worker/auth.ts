import type { SupabaseClient } from "@supabase/supabase-js";
import { createMiddleware } from "hono/factory";
import { adminClient } from "./db";
import type { AppBindings, Env, SessionUser } from "./env";
import { isAllowedEmail, parseAllowedDomains } from "./lib/util";

export type AuthResult =
	| { ok: true; user: SessionUser }
	| { ok: false; reason: "missing" | "invalid" | "domain" };

export async function resolveUser(
	env: Env,
	db: SupabaseClient,
	authorization: string | undefined | null,
): Promise<AuthResult> {
	const token = authorization?.startsWith("Bearer ")
		? authorization.slice(7).trim()
		: "";
	if (!token) return { ok: false, reason: "missing" };

	const { data, error } = await db.auth.getUser(token);
	const authUser = data?.user;
	if (error || !authUser?.email) return { ok: false, reason: "invalid" };

	const email = authUser.email.toLowerCase();
	if (!isAllowedEmail(email, parseAllowedDomains(env.ALLOWED_EMAIL_DOMAINS)))
		return { ok: false, reason: "domain" };

	const metadata = (authUser.user_metadata ?? {}) as Record<string, unknown>;
	const fullName =
		typeof metadata.full_name === "string"
			? metadata.full_name
			: typeof metadata.name === "string"
				? metadata.name
				: null;

	const { data: profile } = await db
		.from("profiles")
		.select("id,role,full_name")
		.eq("id", authUser.id)
		.maybeSingle();

	if (!profile) {
		const { error: insertError } = await db.from("profiles").upsert({
			id: authUser.id,
			email,
			full_name: fullName,
			avatar_url:
				typeof metadata.avatar_url === "string" ? metadata.avatar_url : null,
		});
		if (insertError)
			throw new Error(`Could not create profile: ${insertError.message}`);
	}

	return {
		ok: true,
		user: {
			id: authUser.id,
			email,
			role: profile?.role === "admin" ? "admin" : "member",
			fullName: (profile?.full_name as string | null) ?? fullName,
		},
	};
}

export const requireUser = createMiddleware<AppBindings>(async (c, next) => {
	const authorization = c.req.header("authorization");
	if (!authorization?.startsWith("Bearer "))
		return c.json({ error: "unauthorized" }, 401);
	const result = await resolveUser(c.env, adminClient(c.env), authorization);
	if (!result.ok) {
		if (result.reason === "domain")
			return c.json(
				{
					error: "domain_not_allowed",
					message: "Capture2u is limited to company email addresses.",
				},
				403,
			);
		return c.json({ error: "unauthorized" }, 401);
	}
	c.set("user", result.user);
	await next();
});
