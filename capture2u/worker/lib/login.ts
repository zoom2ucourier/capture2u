import { LOGIN_CODE_LENGTH } from "../../shared/types";
import { sha256Hex } from "./tokens";

export const LOGIN_CODE_TTL_SECONDS = 10 * 60;

export function normalizeEmail(value: unknown) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		return null;
	return email;
}

export function newLoginCode() {
	const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
	return String(value % 10 ** LOGIN_CODE_LENGTH).padStart(
		LOGIN_CODE_LENGTH,
		"0",
	);
}

export function normalizeLoginCode(value: unknown) {
	if (typeof value !== "string") return null;
	const code = value.replace(/[\s-]/g, "");
	return new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`).test(code) ? code : null;
}

export const loginCodeHash = (secret: string, email: string, code: string) =>
	sha256Hex(["capture2u-login-code", secret, email, code].join("\n"));
