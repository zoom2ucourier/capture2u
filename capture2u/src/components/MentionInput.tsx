import { type ReactNode, useEffect, useRef, useState } from "react";
import { mentionQuery, splitMentions } from "../../shared/mentions";
import type { Person } from "../../shared/types";
import { api } from "../lib/api";

const SEARCH_DELAY_MS = 150;

export function MentionText({
	text,
	people,
}: {
	text: string;
	people: Person[];
}): ReactNode {
	if (people.length === 0) return text;
	let offset = 0;
	return splitMentions(text, people).map((part) => {
		const key = `${offset}-${part.text.length}`;
		offset += part.text.length;
		return part.mention ? (
			<span key={key} className="mention">
				{part.text}
			</span>
		) : (
			part.text
		);
	});
}

export function MentionInput({
	value,
	label,
	placeholder,
	onChange,
	onMention,
}: {
	value: string;
	label: string;
	placeholder: string;
	onChange: (value: string) => void;
	onMention: (person: Person) => void;
}) {
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [query, setQuery] = useState<string | null>(null);
	const [people, setPeople] = useState<Person[]>([]);
	const [active, setActive] = useState(0);

	useEffect(() => {
		if (query === null) {
			setPeople([]);
			return;
		}
		let cancelled = false;
		const timeout = window.setTimeout(() => {
			api<{ people: Person[] }>(
				`/api/account/people?q=${encodeURIComponent(query)}`,
			)
				.then((result) => {
					if (cancelled) return;
					setPeople(result.people);
					setActive(0);
				})
				.catch(() => undefined);
		}, SEARCH_DELAY_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timeout);
		};
	}, [query]);

	const readQuery = (element: HTMLTextAreaElement) =>
		setQuery(mentionQuery(element.value.slice(0, element.selectionStart)));

	const choose = (person: Person) => {
		const element = inputRef.current;
		if (!element) return;
		const caret = element.selectionStart;
		const before = value.slice(0, caret);
		const typed = mentionQuery(before);
		if (typed === null) return;
		const head = `${before.slice(0, before.length - typed.length - 1)}@${person.name} `;
		onChange(`${head}${value.slice(caret)}`);
		onMention(person);
		setQuery(null);
		window.requestAnimationFrame(() => {
			element.focus();
			element.setSelectionRange(head.length, head.length);
		});
	};

	const open = query !== null && people.length > 0;

	return (
		<div className="mention-input">
			<textarea
				ref={inputRef}
				className="form-input form-textarea"
				rows={2}
				maxLength={4000}
				placeholder={placeholder}
				aria-label={label}
				value={value}
				onChange={(event) => {
					onChange(event.target.value);
					readQuery(event.target);
				}}
				onClick={(event) => readQuery(event.currentTarget)}
				onBlur={() => window.setTimeout(() => setQuery(null), 150)}
				onKeyDown={(event) => {
					if (!open) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const step = event.key === "ArrowDown" ? 1 : -1;
						setActive(
							(current) => (current + step + people.length) % people.length,
						);
					} else if (event.key === "Enter" || event.key === "Tab") {
						const person = people[active];
						if (!person) return;
						event.preventDefault();
						choose(person);
					} else if (event.key === "Escape") {
						setQuery(null);
					}
				}}
			/>
			{open && (
				<ul className="mention-input__list">
					{people.map((person, index) => (
						<li key={person.id}>
							<button
								type="button"
								className={`mention-input__option${
									index === active ? " mention-input__option--active" : ""
								}`}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => choose(person)}
							>
								{person.name}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
