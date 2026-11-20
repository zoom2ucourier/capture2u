const encoder = new TextEncoder();

const toBase64Url = (bytes: ArrayBuffer) => {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

const importKey = (secret: string) =>
	crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

const sign = async (secret: string, payload: string) =>
	toBase64Url(
		await crypto.subtle.sign(
			"HMAC",
			await importKey(secret),
			encoder.encode(payload),
		),
	);

const constantTimeEqual = (left: string, right: string) => {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1)
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
};

export type TokenScope = "play" | "unlock" | "part";

// Token = "<expiry seconds>.<signature>". The scope and subject are bound into
// the signature but not carried in the token, so a token minted for one video
// or purpose cannot be replayed for another.
export async function createToken(
	secret: string,
	scope: TokenScope,
	subject: string,
	ttlSeconds: number,
	now: number = Date.now(),
) {
	if (!secret) throw new Error("MEDIA_TOKEN_SECRET is not set");
	const expires = Math.floor(now / 1000) + ttlSeconds;
	const signature = await sign(secret, [scope, subject, expires].join("\n"));
	return [expires, signature].join(".");
}

export async function verifyToken(
	secret: string,
	scope: TokenScope,
	subject: string,
	token: string | null | undefined,
	now: number = Date.now(),
) {
	if (!secret || !token) return false;
	const separator = token.indexOf(".");
	if (separator <= 0) return false;
	const expires = Number(token.slice(0, separator));
	if (!Number.isInteger(expires) || expires < Math.floor(now / 1000))
		return false;
	const expected = await sign(secret, [scope, subject, expires].join("\n"));
	return constantTimeEqual(expected, token.slice(separator + 1));
}

export async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
