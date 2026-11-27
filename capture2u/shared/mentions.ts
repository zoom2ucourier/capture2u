import type { Person } from "./types";

const MENTION_AT_CARET =
	/(^|\s)@([\p{L}\p{N}.'-]{0,30}(?: [\p{L}\p{N}.'-]{1,30})?)$/u;

// What is being typed after an "@" just before the caret, or null when the
// caret is not in a mention. At most two words, so a finished mention followed
// by more text stops matching.
export const mentionQuery = (textBeforeCaret: string) =>
	MENTION_AT_CARET.exec(textBeforeCaret)?.[2] ?? null;

export const mentionedIn = (text: string, people: Person[]) =>
	people.filter((person) => text.includes(`@${person.name}`));

// Splits a comment into plain text and the names that were mentioned in it,
// longest names first so "Ana Maria" is not read as a mention of "Ana".
export function splitMentions(text: string, people: Person[]) {
	const names = [...new Set(people.map((person) => `@${person.name}`))].sort(
		(left, right) => right.length - left.length,
	);
	const parts: { text: string; mention: boolean }[] = [];
	let rest = text;
	while (rest.length > 0) {
		let nextIndex = -1;
		let nextName = "";
		for (const name of names) {
			const index = rest.indexOf(name);
			if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
				nextIndex = index;
				nextName = name;
			}
		}
		if (nextIndex === -1) {
			parts.push({ text: rest, mention: false });
			break;
		}
		if (nextIndex > 0)
			parts.push({ text: rest.slice(0, nextIndex), mention: false });
		parts.push({ text: nextName, mention: true });
		rest = rest.slice(nextIndex + nextName.length);
	}
	return parts;
}
