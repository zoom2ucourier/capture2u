import { createHash, createHmac } from "node:crypto";
import type { JSXElementConstructor, ReactElement } from "react";

// Capture2u: sends transactional email through Amazon SES instead of Resend.
// Signed by hand (SigV4) so the fork adds no dependencies and the upstream
// lockfile stays untouched.

export interface SesConfig {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	from: string;
}

export interface SesSendInput {
	to: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	cc?: string | string[];
	replyTo?: string;
	test?: boolean;
}

export type SesSendResult =
	| { data: { id: string } | null; error: null }
	| { data: null; error: { name: string; message: string } };

const SES_SIMULATOR_SUCCESS = "success@simulator.amazonses.com";

export function getSesConfig(
	env: Record<string, string | undefined> = process.env,
): SesConfig | null {
	if (env.CAPTURE2U_EMAIL_PROVIDER?.trim().toLowerCase() !== "ses") return null;
	const region = env.CAPTURE2U_SES_REGION?.trim();
	const accessKeyId = env.CAPTURE2U_SES_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.CAPTURE2U_SES_SECRET_ACCESS_KEY?.trim();
	const from = env.CAPTURE2U_EMAIL_FROM?.trim();
	if (!region || !accessKeyId || !secretAccessKey || !from?.includes("@"))
		return null;
	return { region, accessKeyId, secretAccessKey, from };
}

export function isSesSelected(
	env: Record<string, string | undefined> = process.env,
) {
	return env.CAPTURE2U_EMAIL_PROVIDER?.trim().toLowerCase() === "ses";
}

const sha256Hex = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");

const hmac = (key: Buffer | string, value: string) =>
	createHmac("sha256", key).update(value, "utf8").digest();

export interface SignedRequestInput {
	method: string;
	host: string;
	path: string;
	query?: string;
	headers: Record<string, string>;
	body: string;
	region: string;
	service: string;
	accessKeyId: string;
	secretAccessKey: string;
	amzDate: string;
}

export function signAwsRequest(input: SignedRequestInput) {
	const dateStamp = input.amzDate.slice(0, 8);
	const headers: Record<string, string> = {
		...input.headers,
		host: input.host,
		"x-amz-date": input.amzDate,
	};
	const sortedNames = Object.keys(headers)
		.map((name) => name.toLowerCase())
		.sort();
	const lowered = Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name.toLowerCase(),
			value.trim().replace(/\s+/g, " "),
		]),
	);
	const canonicalHeaders = sortedNames
		.map((name) => `${name}:${lowered[name]}\n`)
		.join("");
	const signedHeaders = sortedNames.join(";");
	const canonicalRequest = [
		input.method,
		input.path,
		input.query ?? "",
		canonicalHeaders,
		signedHeaders,
		sha256Hex(input.body),
	].join("\n");
	const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		input.amzDate,
		scope,
		sha256Hex(canonicalRequest),
	].join("\n");
	const signingKey = hmac(
		hmac(
			hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region),
			input.service,
		),
		"aws4_request",
	);
	const signature = createHmac("sha256", signingKey)
		.update(stringToSign, "utf8")
		.digest("hex");
	return {
		signature,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}

const toAmzDate = (date: Date) =>
	date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const toList = (value?: string | string[]) =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

export async function sendViaSes(
	config: SesConfig,
	input: SesSendInput,
): Promise<SesSendResult> {
	const { render } = await import("@react-email/render");
	const html = await render(input.react);
	const text = await render(input.react, { plainText: true });

	const cc = input.test ? [] : toList(input.cc);
	const body = JSON.stringify({
		FromEmailAddress: config.from,
		Destination: {
			ToAddresses: [input.test ? SES_SIMULATOR_SUCCESS : input.to],
			...(cc.length > 0 ? { CcAddresses: cc } : {}),
		},
		...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
		Content: {
			Simple: {
				Subject: { Data: input.subject, Charset: "UTF-8" },
				Body: {
					Html: { Data: html, Charset: "UTF-8" },
					Text: { Data: text, Charset: "UTF-8" },
				},
			},
		},
	});

	const host = `email.${config.region}.amazonaws.com`;
	const path = "/v2/email/outbound-emails";
	const amzDate = toAmzDate(new Date());
	const { authorization } = signAwsRequest({
		method: "POST",
		host,
		path,
		headers: { "content-type": "application/json" },
		body,
		region: config.region,
		service: "ses",
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		amzDate,
	});

	try {
		const response = await fetch(`https://${host}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-amz-date": amzDate,
				authorization,
			},
			body,
			signal: AbortSignal.timeout(15_000),
		});
		const raw = await response.text();
		if (!response.ok) {
			const message = raw.slice(0, 500) || `SES returned ${response.status}`;
			console.error(
				`[email] SES rejected email "${input.subject}" from ${config.from}:`,
				message,
			);
			return {
				data: null,
				error: { name: `ses_${response.status}`, message },
			};
		}
		let id = "";
		try {
			id = (JSON.parse(raw) as { MessageId?: string }).MessageId ?? "";
		} catch {
			id = "";
		}
		return { data: { id }, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`[email] SES request failed for "${input.subject}":`,
			message,
		);
		return { data: null, error: { name: "ses_request_failed", message } };
	}
}
