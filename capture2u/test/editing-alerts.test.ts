import { describe, expect, it } from "vitest";
import { mentionedIn, mentionQuery, splitMentions } from "../shared/mentions";
import {
	keptRanges,
	keptTotal,
	mergeRanges,
	playablePosition,
	toAbsolute,
	toVirtual,
	uncoveredRanges,
} from "../shared/timeline";
import {
	refusedStartStatus,
	titleFromFileName,
	uploadFileKind,
	uploadFileProblem,
} from "../shared/uploads";
import { EXTENSION_KEY_PREFIX, hashExtensionKey } from "../worker/auth";
import { escapeSlack, slackLink, slackQuote } from "../worker/lib/slack";
import {
	isFillerWord,
	normalizeTranscript,
	suggestCuts,
} from "../worker/lib/transcript";
import { peopleSearchTerm } from "../worker/routes/account";
import { commentAlerts, parseCommentInput } from "../worker/routes/comments";
import {
	isAuthState,
	isExtensionRedirect,
	newExtensionKey,
	parseExtensionIds,
} from "../worker/routes/extension";

describe("what viewers see after trims and cuts", () => {
	const kept = keptRanges(120, 10, 100, [
		{ start: 30, end: 40 },
		{ start: 60, end: 70 },
	]);

	it("lists the stretches that are still shown", () => {
		expect(kept).toEqual([
			{ start: 10, end: 30 },
			{ start: 40, end: 60 },
			{ start: 70, end: 100 },
		]);
		expect(keptTotal(kept)).toBe(70);
		expect(keptRanges(120, null, null, [])).toEqual([{ start: 0, end: 120 }]);
	});

	it("ignores cuts outside the trimmed part and merges overlapping ones", () => {
		expect(
			keptRanges(120, 20, 80, [
				{ start: 0, end: 25 },
				{ start: 50, end: 60 },
				{ start: 55, end: 65 },
				{ start: 90, end: 110 },
			]),
		).toEqual([
			{ start: 25, end: 50 },
			{ start: 65, end: 80 },
		]);
		expect(keptRanges(120, null, null, [{ start: 0, end: 120 }])).toEqual([]);
	});

	it("turns a moment in the file into the time the viewer sees, and back", () => {
		expect(toVirtual(kept, 10)).toBe(0);
		expect(toVirtual(kept, 25)).toBe(15);
		expect(toVirtual(kept, 35)).toBe(20);
		expect(toVirtual(kept, 45)).toBe(25);
		expect(toVirtual(kept, 500)).toBe(70);
		expect(toAbsolute(kept, 0)).toBe(10);
		expect(toAbsolute(kept, 25)).toBe(45);
		expect(toAbsolute(kept, 45)).toBe(75);
		expect(toAbsolute(kept, 999)).toBe(100);
	});

	it("says where to play from when the playhead lands in a hidden part", () => {
		expect(playablePosition(kept, 0)).toBe(10);
		expect(playablePosition(kept, 12)).toBe(12);
		expect(playablePosition(kept, 30)).toBe(40);
		expect(playablePosition(kept, 65)).toBe(70);
		expect(playablePosition(kept, 100)).toBeNull();
	});

	it("tidies ranges and drops ones that are too short", () => {
		expect(
			mergeRanges(
				[
					{ start: 5, end: 6 },
					{ start: 1, end: 2 },
					{ start: 2.03, end: 3 },
					{ start: 9, end: 9.05 },
					{ start: 4, end: 4 },
				],
				0.1,
			),
		).toEqual([
			{ start: 1, end: 3 },
			{ start: 5, end: 6 },
		]);
	});

	it("knows which suggestions have already been applied", () => {
		expect(
			uncoveredRanges(
				[
					{ start: 10, end: 12 },
					{ start: 20, end: 25 },
					{ start: 30, end: 31 },
				],
				[
					{ start: 9, end: 13 },
					{ start: 21, end: 25 },
				],
			),
		).toEqual([
			{ start: 20, end: 25 },
			{ start: 30, end: 31 },
		]);
	});
});

describe("pauses and filler words", () => {
	const word = (text: string, start: number, end: number) => ({
		text,
		start,
		end,
	});

	it("recognises ums and uhs but not real words", () => {
		for (const text of [
			"um",
			"Umm,",
			"uh",
			"Uhh.",
			"erm",
			"hmm",
			"ah",
			"mm-hmm",
		])
			expect(isFillerWord(word(text, 1, 1.3))).toBe(true);
		for (const text of ["umbrella", "a", "the", "her", "arm", "mum", "hum"])
			expect(isFillerWord(word(text, 1, 1.3))).toBe(false);
		expect(isFillerWord(word("um", 1, 4))).toBe(false);
	});

	it("suggests long pauses, keeping a little room either side", () => {
		const suggested = suggestCuts(
			[
				word("Hello", 3, 3.4),
				word("there.", 3.5, 4),
				word("Next", 9, 9.3),
				word("step.", 9.4, 10),
				word("Quick", 11, 11.3),
			],
			20,
		);
		expect(suggested.silences).toEqual([
			{ start: 0, end: 2.7 },
			{ start: 4.3, end: 8.7 },
			{ start: 11.6, end: 20 },
		]);
		expect(suggested.fillers).toEqual([]);
	});

	it("suggests filler words and treats them as part of a pause", () => {
		const suggested = suggestCuts(
			[
				word("Open", 0.2, 0.5),
				word("um", 1.5, 1.8),
				word("settings", 3, 3.6),
				word("uh", 3.7, 3.9),
				word("now.", 4, 4.3),
			],
			null,
		);
		expect(suggested.fillers).toEqual([
			{ start: 1.47, end: 1.83 },
			{ start: 3.67, end: 3.93 },
		]);
		expect(suggested.silences).toEqual([{ start: 0.8, end: 2.7 }]);
	});

	it("suggests nothing when the speech model gives no word timings", () => {
		expect(suggestCuts([], 60)).toEqual({ silences: [], fillers: [] });
	});

	it("keeps word timings and leaves filler words out of the transcript", () => {
		const transcript = normalizeTranscript(
			{
				text: "So um this is the report.",
				words: [
					{ text: "So", start: 0, end: 300 },
					{ text: "um", start: 400, end: 700 },
					{ text: "this", start: 900, end: 1100 },
					{ text: "is", start: 1100, end: 1200 },
					{ text: "the", start: 1200, end: 1300 },
					{ text: "report.", start: 1300, end: 2000 },
				],
			},
			{ timesInMilliseconds: true },
		);
		expect(transcript.words).toHaveLength(6);
		expect(transcript.text).toBe("So this is the report.");
		expect(transcript.segments).toEqual([
			{ start: 0, end: 2, text: "So this is the report." },
		]);
	});

	it("reads a Deepgram transcript with punctuated words", () => {
		const transcript = normalizeTranscript(
			{
				results: {
					channels: [
						{
							alternatives: [
								{
									transcript: "Hello there.",
									words: [
										{ word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.5 },
										{ word: "there", punctuated_word: "there.", start: 0.6, end: 1.1 },
									],
								},
							],
						},
					],
				},
			},
			{ timesInMilliseconds: false },
		);
		expect(transcript.text).toBe("Hello there.");
		expect(transcript.words).toEqual([
			{ text: "Hello", start: 0.1, end: 0.5 },
			{ text: "there.", start: 0.6, end: 1.1 },
		]);
		expect(transcript.segments).toEqual([
			{ start: 0.1, end: 1.1, text: "Hello there." },
		]);
	});

	it("reads word timings nested inside Whisper segments", () => {
		const transcript = normalizeTranscript(
			{
				text: "Hello there.",
				segments: [
					{
						start: 0,
						end: 2,
						text: "Hello there.",
						words: [
							{ word: "Hello", start: 0.1, end: 0.5 },
							{ word: "there.", start: 0.6, end: 1.1 },
						],
					},
				],
			},
			{ timesInMilliseconds: false },
		);
		expect(transcript.words).toEqual([
			{ text: "Hello", start: 0.1, end: 0.5 },
			{ text: "there.", start: 0.6, end: 1.1 },
		]);
	});
});

describe("mentions", () => {
	const ana = { id: "11111111-1111-4111-8111-111111111111", name: "Ana Reyes" };
	const anaMaria = {
		id: "22222222-2222-4222-8222-222222222222",
		name: "Ana Reyes Cruz",
	};

	it("finds what is being typed after an @", () => {
		expect(mentionQuery("please check @an")).toBe("an");
		expect(mentionQuery("@")).toBe("");
		expect(mentionQuery("hi @Ana Re")).toBe("Ana Re");
		expect(mentionQuery("email me at ana@locate2u")).toBeNull();
		expect(mentionQuery("@Ana Reyes ")).toBeNull();
		expect(mentionQuery("@Ana Reyes and then")).toBeNull();
		expect(mentionQuery("no mention here")).toBeNull();
	});

	it("keeps only the people still named in the text", () => {
		expect(mentionedIn("thanks @Ana Reyes", [ana, anaMaria])).toEqual([ana]);
		expect(mentionedIn("thanks", [ana])).toEqual([]);
	});

	it("splits a comment around the names, longest first", () => {
		expect(
			splitMentions("cc @Ana Reyes Cruz and @Ana Reyes!", [ana, anaMaria]),
		).toEqual([
			{ text: "cc ", mention: false },
			{ text: "@Ana Reyes Cruz", mention: true },
			{ text: " and ", mention: false },
			{ text: "@Ana Reyes", mention: true },
			{ text: "!", mention: false },
		]);
		expect(splitMentions("plain", [ana])).toEqual([
			{ text: "plain", mention: false },
		]);
	});

	it("accepts mentions on text comments only", () => {
		expect(
			parseCommentInput({ body: "hi @Ana Reyes", mentions: [ana.id, ana.id] }),
		).toMatchObject({ mentions: [ana.id] });
		expect(parseCommentInput({ body: "hi", mentions: ["nope"] })).toBe(
			"invalid",
		);
		expect(parseCommentInput({ body: "hi", mentions: "all" })).toBe("invalid");
		expect(
			parseCommentInput({ kind: "emoji", body: "👍", mentions: [ana.id] }),
		).toBe("invalid");
		expect(
			parseCommentInput({
				body: "hi",
				mentions: Array.from({ length: 21 }, () => ana.id),
			}),
		).toBe("invalid");
	});

	it("searches colleagues with a cleaned-up term", () => {
		expect(peopleSearchTerm("  Ana Reyes ")).toBe("ana reyes");
		expect(peopleSearchTerm("a%n,a)(")).toBe("ana");
		expect(peopleSearchTerm(undefined)).toBe("");
	});
});

describe("Slack alerts", () => {
	it("sends each person one alert, for the most specific reason", () => {
		expect([
			...commentAlerts({
				authorId: "author",
				ownerId: "owner",
				parentAuthorId: "parent",
				mentions: ["owner", "other", "author"],
			}),
		]).toEqual([
			["owner", "mention"],
			["parent", "reply"],
			["other", "mention"],
		]);
	});

	it("never alerts people about their own comment", () => {
		expect(
			commentAlerts({
				authorId: "owner",
				ownerId: "owner",
				parentAuthorId: "owner",
				mentions: ["owner"],
			}).size,
		).toBe(0);
	});

	it("escapes names, titles and quoted text for Slack", () => {
		expect(escapeSlack("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
		expect(slackLink("https://x.test/v/abc", "Q3 <plan> | draft")).toBe(
			"<https://x.test/v/abc|Q3 &lt;plan&gt; ¦ draft>",
		);
		expect(slackQuote("line one\nline <two>")).toBe(
			"> line one\n> line &lt;two&gt;",
		);
		expect(slackQuote("x".repeat(400)).length).toBeLessThanOrEqual(282);
	});
});

describe("uploading an existing video", () => {
	it("accepts the common video types by name or by type", () => {
		expect(uploadFileKind({ name: "demo.MP4", type: "" })).toEqual({
			extension: "mp4",
			contentType: "video/mp4",
		});
		expect(
			uploadFileKind({ name: "phone.mov", type: "video/quicktime" }),
		).toEqual({ extension: "mov", contentType: "video/quicktime" });
		expect(uploadFileKind({ name: "clip", type: "video/webm" })).toEqual({
			extension: "webm",
			contentType: "video/webm",
		});
		expect(
			uploadFileKind({ name: "notes.pdf", type: "application/pdf" }),
		).toBeNull();
	});

	it("explains why a file cannot be uploaded", () => {
		expect(
			uploadFileProblem({ name: "a.mp4", type: "video/mp4", size: 10 }),
		).toBeNull();
		expect(uploadFileProblem({ name: "a.pdf", type: "", size: 10 })).toMatch(
			/not supported/,
		);
		expect(uploadFileProblem({ name: "a.mp4", type: "", size: 0 })).toMatch(
			/empty/,
		);
		expect(
			uploadFileProblem({ name: "a.mp4", type: "", size: 5 * 1024 ** 3 }),
		).toMatch(/too large/);
	});

	it("makes a readable title from the file name", () => {
		expect(titleFromFileName("Zoom_meeting  recap.mp4")).toBe(
			"Zoom meeting recap",
		);
		expect(titleFromFileName(".mov")).toBe("Uploaded video");
	});

	it("reads why the server refused to start an upload", () => {
		expect(
			refusedStartStatus(
				new Error(
					'Request to /api/upload/multipart/initiate failed: 409 {"error":"already_uploaded"}',
				),
			),
		).toBe(409);
		expect(
			refusedStartStatus(
				new Error("Request to /api/upload/multipart/complete failed: 500 x"),
			),
		).toBeNull();
		expect(refusedStartStatus("nope")).toBeNull();
	});
});

describe("browser extension sign-in", () => {
	const ours = "abcdefghijklmnopabcdefghijklmnop";
	const allowed = parseExtensionIds(` ${ours.toUpperCase()} , not-an-id,`);

	it("reads the list of extensions that may sign in", () => {
		expect(allowed).toEqual([ours]);
		expect(parseExtensionIds("")).toEqual([]);
	});

	it("only hands a key back to the Capture2u extension", () => {
		expect(
			isExtensionRedirect(`https://${ours}.chromiumapp.org/`, allowed),
		).toBe(true);
		expect(
			isExtensionRedirect(`https://${ours}.chromiumapp.org/callback`, allowed),
		).toBe(true);
		for (const bad of [
			"https://evil.example.com/",
			"https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/",
			`https://${ours}.chromiumapp.org.evil.com/`,
			`http://${ours}.chromiumapp.org/`,
			`https://${ours}.chromiumapp.org/#x`,
			"javascript:alert(1)",
			undefined,
		])
			expect(isExtensionRedirect(bad, allowed)).toBe(false);
		expect(isExtensionRedirect(`https://${ours}.chromiumapp.org/`, [])).toBe(
			false,
		);
	});

	it("accepts only plain state values", () => {
		expect(isAuthState("0b6c2f6e-9d0a-4c7e-8f6d-2d1a4b7c9e10")).toBe(true);
		expect(isAuthState("a&authApiKey=stolen")).toBe(false);
		expect(isAuthState("")).toBe(false);
	});

	it("makes keys that are long, unique and stored only as a hash", async () => {
		const first = newExtensionKey();
		const second = newExtensionKey();
		expect(first).toMatch(new RegExp(`^${EXTENSION_KEY_PREFIX}[0-9a-f]{64}$`));
		expect(first).not.toBe(second);
		const hash = await hashExtensionKey(first);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toContain(first.slice(EXTENSION_KEY_PREFIX.length));
		expect(await hashExtensionKey(first)).toBe(hash);
		expect(await hashExtensionKey(second)).not.toBe(hash);
	});
});
