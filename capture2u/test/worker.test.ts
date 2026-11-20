import { describe, expect, it } from "vitest";
import type { SessionUser } from "../worker/env";
import { readRetentionConfig, retentionCutoff } from "../worker/jobs/retention";
import { hashPassword, verifyPassword } from "../worker/lib/password";
import { createToken, verifyToken } from "../worker/lib/tokens";
import {
	formatVttTime,
	normalizeTranscript,
	parseAiSummary,
	segmentsToVtt,
	transcriptForPrompt,
} from "../worker/lib/transcript";
import {
	expiryDate,
	isAllowedEmail,
	isVideoId,
	newVideoId,
	parseAllowedDomains,
	parseRangeHeader,
} from "../worker/lib/util";
import { checkAccess } from "../worker/routes/watch";

const SECRET = "test-secret-value";
const NOW = Date.UTC(2026, 10, 20);

describe("tokens", () => {
	it("accepts a token for the same scope and subject", async () => {
		const token = await createToken(SECRET, "play", "abc12345", 60, NOW);
		expect(await verifyToken(SECRET, "play", "abc12345", token, NOW)).toBe(
			true,
		);
	});

	it("rejects a token used for another video", async () => {
		const token = await createToken(SECRET, "play", "abc12345", 60, NOW);
		expect(await verifyToken(SECRET, "play", "zzz99999", token, NOW)).toBe(
			false,
		);
	});

	it("rejects a token used for another purpose", async () => {
		const token = await createToken(SECRET, "unlock", "abc12345", 60, NOW);
		expect(await verifyToken(SECRET, "play", "abc12345", token, NOW)).toBe(
			false,
		);
	});

	it("rejects an expired token", async () => {
		const token = await createToken(SECRET, "play", "abc12345", 60, NOW);
		expect(
			await verifyToken(SECRET, "play", "abc12345", token, NOW + 61_000),
		).toBe(false);
	});

	it("rejects a token whose expiry was edited", async () => {
		const token = await createToken(SECRET, "play", "abc12345", 60, NOW);
		const [expires, signature] = token.split(".");
		const forged = `${Number(expires) + 100000}.${signature}`;
		expect(await verifyToken(SECRET, "play", "abc12345", forged, NOW)).toBe(
			false,
		);
	});

	it("rejects a token signed with another secret", async () => {
		const token = await createToken(
			"other-secret",
			"play",
			"abc12345",
			60,
			NOW,
		);
		expect(await verifyToken(SECRET, "play", "abc12345", token, NOW)).toBe(
			false,
		);
	});

	it("rejects missing and malformed tokens", async () => {
		expect(await verifyToken(SECRET, "play", "abc12345", null, NOW)).toBe(
			false,
		);
		expect(await verifyToken(SECRET, "play", "abc12345", "", NOW)).toBe(false);
		expect(await verifyToken(SECRET, "play", "abc12345", "nonsense", NOW)).toBe(
			false,
		);
	});
});

describe("passwords", () => {
	it("verifies the right password and rejects a wrong one", async () => {
		const stored = await hashPassword("correct horse");
		expect(stored).not.toContain("correct horse");
		expect(await verifyPassword("correct horse", stored)).toBe(true);
		expect(await verifyPassword("wrong horse", stored)).toBe(false);
	});

	it("uses a fresh salt each time", async () => {
		expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
	});

	it("rejects a malformed stored value", async () => {
		expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
	});
});

describe("sign-up domains", () => {
	const domains = parseAllowedDomains(
		" zoom2u.com, Locate2u.com ,locatetech.nz,freightmatch.com.au ",
	);

	it("allows the four company domains", () => {
		expect(isAllowedEmail("a@zoom2u.com", domains)).toBe(true);
		expect(isAllowedEmail("a@LOCATE2U.com", domains)).toBe(true);
		expect(isAllowedEmail("a@locatetech.nz", domains)).toBe(true);
		expect(isAllowedEmail("a@freightmatch.com.au", domains)).toBe(true);
	});

	it("refuses other domains, sub-domains and look-alikes", () => {
		expect(isAllowedEmail("a@gmail.com", domains)).toBe(false);
		expect(isAllowedEmail("a@mail.zoom2u.com", domains)).toBe(false);
		expect(isAllowedEmail("a@zoom2u.com.evil.com", domains)).toBe(false);
		expect(isAllowedEmail("zoom2u.com", domains)).toBe(false);
		expect(isAllowedEmail("a@zoom2u.com@evil.com", domains)).toBe(false);
		expect(isAllowedEmail(null, domains)).toBe(false);
	});
});

describe("video ids", () => {
	it("generates ids that pass validation", () => {
		for (let i = 0; i < 50; i += 1) expect(isVideoId(newVideoId())).toBe(true);
	});

	it("rejects path tricks", () => {
		expect(isVideoId("../secret")).toBe(false);
		expect(isVideoId("abc")).toBe(false);
		expect(isVideoId("ABCDEFGH")).toBe(false);
	});
});

describe("range requests", () => {
	it("returns null when there is no range", () => {
		expect(parseRangeHeader(null, 1000)).toBeNull();
	});

	it("parses start-end, open-ended and suffix ranges", () => {
		expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({
			offset: 0,
			length: 100,
		});
		expect(parseRangeHeader("bytes=500-", 1000)).toEqual({
			offset: 500,
			length: 500,
		});
		expect(parseRangeHeader("bytes=-200", 1000)).toEqual({
			offset: 800,
			length: 200,
		});
	});

	it("clamps an end past the file size", () => {
		expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({
			offset: 900,
			length: 100,
		});
	});

	it("flags unsatisfiable or malformed ranges", () => {
		expect(parseRangeHeader("bytes=1000-", 1000)).toBe("invalid");
		expect(parseRangeHeader("bytes=50-10", 1000)).toBe("invalid");
		expect(parseRangeHeader("bytes=-", 1000)).toBe("invalid");
		expect(parseRangeHeader("items=0-1", 1000)).toBe("invalid");
		expect(parseRangeHeader("bytes=0-1,5-9", 1000)).toBe("invalid");
	});
});

describe("who can watch", () => {
	const owner: SessionUser = {
		id: "owner",
		email: "o@zoom2u.com",
		role: "member",
		fullName: null,
	};
	const colleague: SessionUser = { ...owner, id: "colleague" };
	const admin: SessionUser = { ...owner, id: "admin", role: "admin" };
	const video = (visibility: "public" | "company" | "private") => ({
		owner_id: "owner",
		visibility,
	});

	it("lets anyone watch a public video", () => {
		expect(checkAccess(video("public"), null)).toEqual({
			allowed: true,
			isOwner: false,
		});
	});

	it("needs a signed-in colleague for a company video", () => {
		expect(checkAccess(video("company"), null)).toEqual({
			allowed: false,
			reason: "sign_in",
		});
		expect(checkAccess(video("company"), colleague)).toEqual({
			allowed: true,
			isOwner: false,
		});
	});

	it("keeps a private video to its owner and admins", () => {
		expect(checkAccess(video("private"), null)).toEqual({
			allowed: false,
			reason: "sign_in",
		});
		expect(checkAccess(video("private"), colleague)).toEqual({
			allowed: false,
			reason: "private",
		});
		expect(checkAccess(video("private"), owner)).toEqual({
			allowed: true,
			isOwner: true,
		});
		expect(checkAccess(video("private"), admin)).toEqual({
			allowed: true,
			isOwner: false,
		});
	});
});

describe("retention", () => {
	it("defaults to report-only", () => {
		expect(
			readRetentionConfig({
				RETENTION_MODE: "",
				RETENTION_DAYS: "",
				RETENTION_MAX_PER_RUN: "",
			}),
		).toEqual({ mode: "report", days: 365, maxPerRun: 200 });
	});

	it("only deletes on the exact word delete", () => {
		const read = (mode: string) =>
			readRetentionConfig({
				RETENTION_MODE: mode,
				RETENTION_DAYS: "365",
				RETENTION_MAX_PER_RUN: "200",
			}).mode;
		expect(read("delete")).toBe("delete");
		expect(read(" DELETE ")).toBe("delete");
		expect(read("deleted")).toBe("report");
		expect(read("true")).toBe("report");
		expect(read("yes")).toBe("report");
	});

	it("never goes below 30 days or above the nightly ceiling", () => {
		const config = readRetentionConfig({
			RETENTION_MODE: "delete",
			RETENTION_DAYS: "1",
			RETENTION_MAX_PER_RUN: "999999",
		});
		expect(config.days).toBe(30);
		expect(config.maxPerRun).toBe(2000);
	});

	it("computes the cutoff and expiry date", () => {
		const now = new Date("2026-11-20T00:00:00Z");
		expect(retentionCutoff(365, now).toISOString()).toBe(
			"2025-11-20T00:00:00.000Z",
		);
		expect(expiryDate("2026-11-20T00:00:00Z", false, 365)).toBe(
			"2027-11-20T00:00:00.000Z",
		);
		expect(expiryDate("2026-11-20T00:00:00Z", true, 365)).toBeNull();
	});
});

describe("transcripts", () => {
	it("reads Whisper-style segments in seconds", () => {
		const result = normalizeTranscript(
			{
				text: "Hello there. General update.",
				segments: [
					{ start: 0, end: 1.5, text: " Hello there." },
					{ start: 1.5, end: 4, text: " General update." },
				],
			},
			{ timesInMilliseconds: false },
		);
		expect(result.segments).toEqual([
			{ start: 0, end: 1.5, text: "Hello there." },
			{ start: 1.5, end: 4, text: "General update." },
		]);
	});

	it("groups AssemblyAI-style words in milliseconds into segments", () => {
		const words = Array.from({ length: 40 }, (_, index) => ({
			text: index % 10 === 9 ? `word${index}.` : `word${index}`,
			start: index * 500,
			end: index * 500 + 400,
		}));
		const result = normalizeTranscript(
			{ text: "", words },
			{ timesInMilliseconds: true },
		);
		expect(result.segments.length).toBeGreaterThan(1);
		expect(result.segments[0]?.start).toBe(0);
		expect(result.segments.at(-1)?.end).toBeCloseTo(19.9, 5);
		expect(result.text).toContain("word0 word1");
	});

	it("unwraps a nested result and falls back to one block of text", () => {
		const result = normalizeTranscript(
			{ result: { text: "Only text here" } },
			{ timesInMilliseconds: false, durationSeconds: 12 },
		);
		expect(result.segments).toEqual([
			{ start: 0, end: 12, text: "Only text here" },
		]);
	});

	it("returns nothing for an empty or unknown shape", () => {
		expect(normalizeTranscript(null, { timesInMilliseconds: false })).toEqual({
			text: "",
			segments: [],
		});
		expect(
			normalizeTranscript({ foo: 1 }, { timesInMilliseconds: false }),
		).toEqual({ text: "", segments: [] });
	});

	it("writes valid caption timings", () => {
		expect(formatVttTime(3725.5)).toBe("01:02:05.500");
		const vtt = segmentsToVtt([
			{ start: 0, end: 2, text: "First --> line" },
			{ start: 2, end: 2, text: "skipped, zero length" },
		]);
		expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n")).toBe(
			true,
		);
		expect(vtt).toContain("First -> line");
		expect(vtt).not.toContain("skipped");
	});

	it("limits the transcript sent to the AI", () => {
		const segments = Array.from({ length: 100 }, (_, index) => ({
			start: index * 5,
			end: index * 5 + 5,
			text: "x".repeat(50),
		}));
		expect(transcriptForPrompt(segments, 500).length).toBeLessThanOrEqual(500);
	});
});

describe("AI summary parsing", () => {
	it("reads an object response", () => {
		const result = parseAiSummary(
			{
				response: {
					title: '"Weekly routing update"',
					summary: "A short summary.",
					chapters: [
						{ title: "Later", start: 90 },
						{ title: "Intro", start: 0 },
						{ title: "Past the end", start: 9999 },
						{ title: "", start: 10 },
					],
				},
			},
			300,
		);
		expect(result.title).toBe("Weekly routing update");
		expect(result.chapters).toEqual([
			{ title: "Intro", start: 0 },
			{ title: "Later", start: 90 },
		]);
	});

	it("reads JSON wrapped in text", () => {
		const result = parseAiSummary(
			{
				response:
					'Here you go:\n{"title":"Demo","summary":"S","chapters":[]}\nThanks',
			},
			60,
		);
		expect(result).toEqual({ title: "Demo", summary: "S", chapters: [] });
	});

	it("survives garbage", () => {
		expect(parseAiSummary({ response: "not json {" }, 60)).toEqual({
			title: null,
			summary: null,
			chapters: [],
		});
		expect(parseAiSummary(undefined, null)).toEqual({
			title: null,
			summary: null,
			chapters: [],
		});
	});
});
