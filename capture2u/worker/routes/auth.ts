import { Hono } from "hono";
import { adminClient } from "../db";
import type { AppBindings } from "../env";
import { loginCodeEmail, sendEmail } from "../lib/email";
import {
	LOGIN_CODE_TTL_SECONDS,
	loginCodeHash,
	newLoginCode,
	normalizeEmail,
	normalizeLoginCode,
} from "../lib/login";
import { isAllowedEmail, parseAllowedDomains } from "../lib/util";

export const auth = new Hono<AppBindings>();

auth.post("/code", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
	const email = normalizeEmail(body.email);
	if (!email)
		return c.json(
			{ error: "invalid_email", message: "Enter your work email address." },
			400,
		);
	if (!isAllowedEmail(email, parseAllowedDomains(c.env.ALLOWED_EMAIL_DOMAINS)))
		return c.json(
			{
				error: "domain_not_allowed",
				message: "Capture2u is limited to company email addresses.",
			},
			403,
		);
	if (!c.env.MEDIA_TOKEN_SECRET) throw new Error("Sign-in is not configured");

	const code = newLoginCode();
	const { data, error } = await adminClient(c.env).rpc("issue_login_code", {
		p_email: email,
		p_code_hash: await loginCodeHash(c.env.MEDIA_TOKEN_SECRET, email, code),
		p_ttl_seconds: LOGIN_CODE_TTL_SECONDS,
	});
	if (error) throw new Error(`Could not issue code: ${error.message}`);
	if (data === "wait")
		return c.json(
			{
				error: "too_soon",
				message: "A code was just sent. Wait 30 seconds before asking again.",
			},
			429,
		);
	if (data === "limit")
		return c.json(
			{
				error: "too_many_codes",
				message: "Too many attempts. Try again in an hour.",
			},
			429,
		);

	try {
		await sendEmail(
			c.env,
			loginCodeEmail(email, code, LOGIN_CODE_TTL_SECONDS / 60),
		);
	} catch (cause) {
		console.error("[capture2u] sign-in email", cause);
		return c.json(
			{
				error: "email_unavailable",
				message: "The code could not be emailed. Please try again shortly.",
			},
			503,
		);
	}
	return c.json({ sent: true });
});

auth.post("/verify", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		email?: unknown;
		code?: unknown;
	};
	const email = normalizeEmail(body.email);
	const code = normalizeLoginCode(body.code);
	if (
		!email ||
		!code ||
		!isAllowedEmail(email, parseAllowedDomains(c.env.ALLOWED_EMAIL_DOMAINS))
	)
		return c.json(
			{ error: "invalid_code", message: "That code is not right." },
			401,
		);
	if (!c.env.MEDIA_TOKEN_SECRET) throw new Error("Sign-in is not configured");

	const db = adminClient(c.env);
	const { data, error } = await db.rpc("check_login_code", {
		p_email: email,
		p_code_hash: await loginCodeHash(c.env.MEDIA_TOKEN_SECRET, email, code),
	});
	if (error) throw new Error(`Could not check code: ${error.message}`);
	if (data === "locked")
		return c.json(
			{
				error: "too_many_attempts",
				message: "Too many wrong codes. Ask for a new code.",
			},
			429,
		);
	if (data === "expired")
		return c.json(
			{
				error: "code_expired",
				message: "That code has expired. Ask for a new one.",
			},
			401,
		);
	if (data !== "ok")
		return c.json(
			{ error: "invalid_code", message: "That code is not right." },
			401,
		);

	const { data: profile } = await db
		.from("profiles")
		.select("id")
		.eq("email", email)
		.maybeSingle();
	if (!profile) {
		const created = await db.auth.admin.createUser({
			email,
			email_confirm: true,
		});
		if (created.error && created.error.code !== "email_exists")
			console.error("[capture2u] create user", created.error.message);
	}

	const link = await db.auth.admin.generateLink({ type: "magiclink", email });
	const properties = link.data?.properties;
	if (link.error || !properties?.hashed_token)
		throw new Error(
			`Could not start session: ${link.error?.message ?? "no token returned"}`,
		);
	return c.json({ tokenHash: properties.hashed_token }, 200, {
		"Cache-Control": "no-store",
	});
});
