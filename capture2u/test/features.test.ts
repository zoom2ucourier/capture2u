import { describe, expect, it } from "vitest";
import { LOGIN_CODE_LENGTH } from "../shared/types";
import { loginCodeEmail } from "../worker/lib/email";
import {
	loginCodeHash,
	newLoginCode,
	normalizeEmail,
	normalizeLoginCode,
} from "../worker/lib/login";
import { hmacSha256Hex } from "../worker/lib/tokens";
import {
	displayName,
	embedHtml,
	isUuid,
	normalizeCuts,
	normalizeTrim,
	visibleChapters,
	visibleDuration,
	visibleRanges,
	visibleSegments,
} from "../worker/lib/util";
import { parseCommentInput } from "../worker/routes/comments";
import { parseFolderName } from "../worker/routes/folders";
import { sharedVideoId, verifySlackSignature } from "../worker/routes/slack";

describe("sign-in codes", () => {
	it("generates six digits every time, keeping leading zeros", () => {
		for (let i = 0; i < 200; i += 1)
			expect(newLoginCode()).toMatch(new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`));
	});

	it("accepts a code typed with spaces or a dash", () => {
		expect(normalizeLoginCode("123 456")).toBe("123456");
		expect(normalizeLoginCode("123-456")).toBe("123456");
	});

	it("rejects codes of the wrong shape", () => {
		expect(normalizeLoginCode("12345")).toBeNull();
		expect(normalizeLoginCode("1234567")).toBeNull();
		expect(normalizeLoginCode("12a456")).toBeNull();
		expect(normalizeLoginCode(123456)).toBeNull();
	});

	it("tidies email addresses and rejects malformed ones", () => {
		expect(normalizeEmail("  Jane@Locate2u.com ")).toBe("jane@locate2u.com");
		expect(normalizeEmail("jane")).toBeNull();
		expect(normalizeEmail("jane@locate2u")).toBeNull();
		expect(normalizeEmail("ja ne@locate2u.com")).toBeNull();
		expect(normalizeEmail(null)).toBeNull();
	});

	it("ties the stored hash to the address, the code and the secret", async () => {
		const hash = await loginCodeHash("secret", "a@zoom2u.com", "123456");
		expect(hash).not.toContain("123456");
		expect(await loginCodeHash("secret", "a@zoom2u.com", "123456")).toBe(hash);
		expect(await loginCodeHash("secret", "b@zoom2u.com", "123456")).not.toBe(
			hash,
		);
		expect(await loginCodeHash("secret", "a@zoom2u.com", "123457")).not.toBe(
			hash,
		);
		expect(await loginCodeHash("other", "a@zoom2u.com", "123456")).not.toBe(
			hash,
		);
	});
});

describe("emails", () => {
	it("puts the code in the sign-in email", () => {
		const email = loginCodeEmail("a@zoom2u.com", "004219", 10);
		expect(email.to).toBe("a@zoom2u.com");
		expect(email.subject).toContain("004219");
		expect(email.text).toContain("004219");
		expect(email.html).toContain("004219");
	});
});

describe("trim", () => {
	it("keeps a valid start and end", () => {
		expect(normalizeTrim(5, 60, 120)).toEqual({ start: 5, end: 60 });
	});

	it("treats a start of zero and an end at the full length as no trim", () => {
		expect(normalizeTrim(0, 120, 120)).toEqual({ start: null, end: null });
		expect(normalizeTrim(null, null, 120)).toEqual({ start: null, end: null });
	});

	it("rejects a trim that leaves less than a second", () => {
		expect(normalizeTrim(30, 30.5, 120)).toBe("invalid");
		expect(normalizeTrim(60, 20, 120)).toBe("invalid");
		expect(normalizeTrim(119.5, null, 120)).toBe("invalid");
		expect(normalizeTrim(null, 0.5, 120)).toBe("invalid");
	});

	it("rejects values that are not sensible times", () => {
		expect(normalizeTrim(-1, null, 120)).toBe("invalid");
		expect(normalizeTrim("5", null, 120)).toBe("invalid");
		expect(normalizeTrim(Number.NaN, null, 120)).toBe("invalid");
		expect(normalizeTrim(500, null, 120)).toBe("invalid");
	});

	it("hides transcript lines and chapters outside the trim", () => {
		const segments = [
			{ start: 0, end: 4, text: "before" },
			{ start: 4, end: 9, text: "overlaps start" },
			{ start: 20, end: 25, text: "inside" },
			{ start: 61, end: 70, text: "after" },
		];
		const trimmed = visibleRanges(120, { start: 5, end: 60 }, []);
		expect(visibleSegments(segments, trimmed).map((item) => item.text)).toEqual(
			["overlaps start", "inside"],
		);
		expect(
			visibleSegments(
				segments,
				visibleRanges(120, { start: null, end: null }, []),
			),
		).toEqual(segments);
		expect(
			visibleChapters(
				[
					{ title: "Intro", start: 0 },
					{ title: "Demo", start: 30 },
					{ title: "Wrap", start: 90 },
				],
				trimmed,
			).map((item) => item.title),
		).toEqual(["Intro", "Demo"]);
	});

	it("reports the length viewers see", () => {
		expect(visibleDuration(120, { start: 5, end: 60 }, [])).toBe(55);
		expect(visibleDuration(120, { start: null, end: null }, [])).toBe(120);
		expect(visibleDuration(120, { start: 20, end: null }, [])).toBe(100);
		expect(visibleDuration(null, { start: 5, end: 60 }, [])).toBeNull();
	});
});

describe("cuts", () => {
	const noTrim = { start: null, end: null };

	it("sorts, merges and tidies the sections an owner cuts out", () => {
		expect(
			normalizeCuts(
				[
					{ start: 40, end: 50 },
					{ start: 10, end: 20 },
					{ start: 19.5, end: 25 },
					{ start: 70, end: 70.04 },
				],
				120,
				noTrim,
			),
		).toEqual([
			{ start: 10, end: 25 },
			{ start: 40, end: 50 },
		]);
		expect(normalizeCuts(null, 120, noTrim)).toEqual([]);
		expect(normalizeCuts([{ start: 100, end: 500 }], 120, noTrim)).toEqual([
			{ start: 100, end: 120 },
		]);
	});

	it("rejects cuts that are not sensible", () => {
		expect(normalizeCuts("all", 120, noTrim)).toBe("invalid");
		expect(normalizeCuts([{ start: 20, end: 10 }], 120, noTrim)).toBe(
			"invalid",
		);
		expect(normalizeCuts([{ start: -1, end: 10 }], 120, noTrim)).toBe(
			"invalid",
		);
		expect(normalizeCuts([{ start: "1", end: 10 }], 120, noTrim)).toBe(
			"invalid",
		);
	});

	it("rejects cuts that would leave nothing to watch", () => {
		expect(normalizeCuts([{ start: 0, end: 119.5 }], 120, noTrim)).toBe(
			"invalid",
		);
		expect(
			normalizeCuts([{ start: 10, end: 59.5 }], 120, { start: 10, end: 60 }),
		).toBe("invalid");
	});

	it("takes cuts off the length viewers see and hides what was said in them", () => {
		const cuts = [{ start: 20, end: 50 }];
		expect(visibleDuration(120, { start: 10, end: null }, cuts)).toBe(80);
		const kept = visibleRanges(120, noTrim, cuts);
		expect(
			visibleSegments(
				[
					{ start: 0, end: 8, text: "shown" },
					{ start: 22, end: 30, text: "cut" },
					{ start: 48, end: 56, text: "partly shown" },
				],
				kept,
			).map((item) => item.text),
		).toEqual(["shown", "partly shown"]);
		expect(
			visibleChapters(
				[
					{ title: "Intro", start: 0 },
					{ title: "Cut away", start: 20 },
					{ title: "Starts in the cut", start: 45 },
					{ title: "End", start: 90 },
				],
				visibleRanges(120, noTrim, [{ start: 20, end: 50 }]),
			).map((item) => item.title),
		).toEqual(["Intro", "Starts in the cut", "End"]);
	});
});

describe("comments and reactions", () => {
	it("accepts a text comment with a moment in the video", () => {
		expect(
			parseCommentInput({ body: "  Nice one  ", timestampSeconds: 12.34 }),
		).toEqual({
			kind: "text",
			body: "Nice one",
			timestampSeconds: 12.3,
			parentId: null,
			mentions: [],
		});
	});

	it("accepts only the listed reactions", () => {
		expect(parseCommentInput({ kind: "emoji", body: "👍" })).toMatchObject({
			kind: "emoji",
			body: "👍",
		});
		expect(parseCommentInput({ kind: "emoji", body: "💩" })).toBe("invalid");
		expect(parseCommentInput({ kind: "emoji", body: "hello" })).toBe("invalid");
	});

	it("rejects empty, oversized and malformed comments", () => {
		expect(parseCommentInput({ body: "   " })).toBe("invalid");
		expect(parseCommentInput({ body: "x".repeat(4001) })).toBe("invalid");
		expect(parseCommentInput({ body: 5 })).toBe("invalid");
		expect(parseCommentInput({ body: "ok", timestampSeconds: -1 })).toBe(
			"invalid",
		);
		expect(parseCommentInput({ body: "ok", parentId: "not-an-id" })).toBe(
			"invalid",
		);
	});

	it("does not allow a reply to be a reaction", () => {
		expect(
			parseCommentInput({
				kind: "emoji",
				body: "👍",
				parentId: "3f0c2c0e-58a5-4d0e-9a54-1f1a6f0b9c11",
			}),
		).toBe("invalid");
	});
});

describe("folders", () => {
	it("tidies folder names", () => {
		expect(parseFolderName("  Product   demos ")).toBe("Product demos");
	});

	it("rejects empty and oversized names", () => {
		expect(parseFolderName("   ")).toBeNull();
		expect(parseFolderName("x".repeat(81))).toBeNull();
		expect(parseFolderName(42)).toBeNull();
	});

	it("recognises folder ids", () => {
		expect(isUuid("3f0c2c0e-58a5-4d0e-9a54-1f1a6f0b9c11")).toBe(true);
		expect(isUuid("3f0c2c0e58a54d0e9a541f1a6f0b9c11")).toBe(false);
		expect(isUuid("owner_id.eq.1,shared.eq.true")).toBe(false);
	});
});

describe("embed and Slack", () => {
	const BASE = "https://capture.locate2u.com";
	const NOW = Date.UTC(2026, 10, 25);
	const timestamp = String(Math.floor(NOW / 1000));
	const body = JSON.stringify({ type: "event_callback" });

	it("builds an embed code that cannot be broken by the title", () => {
		const html = embedHtml(BASE, "abc12345", 'Demo "><script>x</script>');
		expect(html).toContain(`src="${BASE}/embed/abc12345"`);
		expect(html).not.toContain("<script>");
	});

	it("only treats links to our own share pages as videos", () => {
		expect(sharedVideoId(`${BASE}/v/abc12345`, BASE)).toBe("abc12345");
		expect(sharedVideoId(`${BASE}/v/abc12345/`, BASE)).toBe("abc12345");
		expect(
			sharedVideoId("https://evil.example.com/v/abc12345", BASE),
		).toBeNull();
		expect(sharedVideoId(`${BASE}/embed/abc12345`, BASE)).toBeNull();
		expect(sharedVideoId(`${BASE}/v/../secret`, BASE)).toBeNull();
		expect(sharedVideoId("not a link", BASE)).toBeNull();
	});

	it("accepts a request signed by Slack", async () => {
		const signature = `v0=${await hmacSha256Hex("slack-secret", `v0:${timestamp}:${body}`)}`;
		expect(
			await verifySlackSignature(
				"slack-secret",
				timestamp,
				signature,
				body,
				NOW,
			),
		).toBe(true);
	});

	it("rejects a wrong secret, an edited body and an old request", async () => {
		const signature = `v0=${await hmacSha256Hex("slack-secret", `v0:${timestamp}:${body}`)}`;
		expect(
			await verifySlackSignature("other", timestamp, signature, body, NOW),
		).toBe(false);
		expect(
			await verifySlackSignature(
				"slack-secret",
				timestamp,
				signature,
				`${body} `,
				NOW,
			),
		).toBe(false);
		expect(
			await verifySlackSignature(
				"slack-secret",
				timestamp,
				signature,
				body,
				NOW + 10 * 60 * 1000,
			),
		).toBe(false);
		expect(
			await verifySlackSignature(
				"slack-secret",
				timestamp,
				undefined,
				body,
				NOW,
			),
		).toBe(false);
	});
});

describe("names", () => {
	it("uses the saved name, then a name built from the email", () => {
		expect(displayName("Jo Smith", "jo@zoom2u.com")).toBe("Jo Smith");
		expect(displayName(null, "jo.smith@zoom2u.com")).toBe("Jo Smith");
		expect(displayName("  ", "jiro@locate2u.com")).toBe("Jiro");
		expect(displayName(null, null)).toBe("Someone");
	});
});
