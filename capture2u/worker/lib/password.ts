const encoder = new TextEncoder();
const ITERATIONS = 100_000;

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) => {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1)
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
};

async function derive(password: string, salt: Uint8Array, iterations: number) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, ITERATIONS);
	return ["pbkdf2", ITERATIONS, toHex(salt), toHex(hash)].join(":");
}

export async function verifyPassword(password: string, stored: string) {
	const [scheme, iterations, saltHex, hashHex] = stored.split(":");
	if (scheme !== "pbkdf2" || !iterations || !saltHex || !hashHex) return false;
	const expected = fromHex(hashHex);
	const actual = await derive(password, fromHex(saltHex), Number(iterations));
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i += 1)
		diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
	return diff === 0;
}
