import { useCallback, useEffect, useMemo, useState } from "react";
import { mentionedIn } from "../../shared/mentions";
import {
	type Person,
	REACTION_EMOJI,
	type VideoComment,
} from "../../shared/types";
import { api, formatDate } from "../lib/api";
import { Button } from "./common/Button";
import { Card } from "./common/Card";
import { Alert, Avatar } from "./common/Feedback";
import { Icons } from "./common/Icons";
import { MentionInput, MentionText } from "./MentionInput";

interface CommentsProps {
	videoId: string;
	unlockToken: string | null;
	getCurrentTime: () => number;
	onSeek: (seconds: number) => void;
	formatTime: (seconds: number) => string;
}

const mentionIds = (text: string, people: Person[]) => [
	...new Set(mentionedIn(text, people).map((person) => person.id)),
];

export function Comments({
	videoId,
	unlockToken,
	getCurrentTime,
	onSeek,
	formatTime,
}: CommentsProps) {
	const [comments, setComments] = useState<VideoComment[] | null>(null);
	const [draft, setDraft] = useState("");
	const [atCurrentTime, setAtCurrentTime] = useState(true);
	const [replyTo, setReplyTo] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
	const [mentioned, setMentioned] = useState<Person[]>([]);
	const addMention = (person: Person) =>
		setMentioned((current) => [...current, person]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const headers = useMemo(
		(): Record<string, string> =>
			unlockToken ? { "x-unlock-token": unlockToken } : {},
		[unlockToken],
	);

	const load = useCallback(async () => {
		try {
			const result = await api<{ comments: VideoComment[] }>(
				`/api/comments/${videoId}`,
				{ headers },
			);
			setComments(result.comments);
			setError(null);
		} catch {
			setError("Could not load comments.");
		}
	}, [videoId, headers]);

	useEffect(() => {
		void load();
	}, [load]);

	const post = async (body: Record<string, unknown>) => {
		setBusy(true);
		try {
			await api(`/api/comments/${videoId}`, { headers, body });
			await load();
			return true;
		} catch {
			setError("Could not save that. Please try again.");
			return false;
		} finally {
			setBusy(false);
		}
	};

	const remove = async (comment: VideoComment) => {
		if (!window.confirm("Delete this comment?")) return;
		try {
			await api(`/api/comments/${videoId}/${comment.id}`, {
				method: "DELETE",
				headers,
			});
			await load();
		} catch {
			setError("Could not delete that comment.");
		}
	};

	const all = comments ?? [];
	const reactions = all.filter((comment) => comment.kind === "emoji");
	const threads = all.filter(
		(comment) => comment.kind === "text" && comment.parentId === null,
	);
	const repliesTo = (id: string) =>
		all.filter((comment) => comment.parentId === id);

	return (
		<Card
			title="Comments"
			icon={<Icons.MessageSquare />}
			className="comments"
			actions={
				threads.length > 0 && (
					<span className="chip__count">{threads.length}</span>
				)
			}
		>
			{error && <Alert>{error}</Alert>}

			<div className="comments__reactions">
				{REACTION_EMOJI.map((emoji) => {
					const matching = reactions.filter(
						(reaction) => reaction.body === emoji,
					);
					const mine = matching.some((reaction) => reaction.isMine);
					return (
						<button
							key={emoji}
							type="button"
							className={`chip chip--reaction${mine ? " chip--active" : ""}`}
							aria-pressed={mine}
							aria-label={`React with ${emoji}`}
							title={matching.map((reaction) => reaction.authorName).join(", ")}
							disabled={busy}
							onClick={() =>
								void post({
									kind: "emoji",
									body: emoji,
									timestampSeconds: getCurrentTime(),
								})
							}
						>
							{emoji}
							{matching.length > 0 && (
								<span className="chip__count">{matching.length}</span>
							)}
						</button>
					);
				})}
			</div>

			<form
				className="comment-form"
				onSubmit={(event) => {
					event.preventDefault();
					void post({
						kind: "text",
						body: draft,
						timestampSeconds: atCurrentTime ? getCurrentTime() : null,
						mentions: mentionIds(draft, mentioned),
					}).then((saved) => {
						if (saved) setDraft("");
					});
				}}
			>
				<MentionInput
					value={draft}
					label="Add a comment"
					placeholder="Add a comment. Type @ to mention a colleague."
					onChange={setDraft}
					onMention={addMention}
				/>
				<div className="comment-form__footer">
					<label className="check">
						<input
							type="checkbox"
							checked={atCurrentTime}
							onChange={(event) => setAtCurrentTime(event.target.checked)}
						/>
						Link to the current moment
					</label>
					<Button
						type="submit"
						variant="primary"
						size="sm"
						disabled={busy || !draft.trim()}
					>
						Comment
					</Button>
				</div>
			</form>

			{comments === null && !error && (
				<p className="comments__empty">Loading…</p>
			)}
			{comments !== null && threads.length === 0 && (
				<p className="comments__empty">No comments yet.</p>
			)}

			<ul className="comment-list">
				{threads.map((comment) => (
					<li key={comment.id} className="comment-list__thread">
						<CommentBody
							comment={comment}
							onSeek={onSeek}
							onDelete={remove}
							formatTime={formatTime}
						/>
						<ul className="comment-list comment-list--replies">
							{repliesTo(comment.id).map((reply) => (
								<li key={reply.id}>
									<CommentBody
										comment={reply}
										onSeek={onSeek}
										onDelete={remove}
										formatTime={formatTime}
									/>
								</li>
							))}
						</ul>
						{replyTo === comment.id ? (
							<form
								className="comment-form comment-form--reply"
								onSubmit={(event) => {
									event.preventDefault();
									void post({
										kind: "text",
										body: replyDraft,
										parentId: comment.id,
										mentions: mentionIds(replyDraft, mentioned),
									}).then((saved) => {
										if (!saved) return;
										setReplyDraft("");
										setReplyTo(null);
									});
								}}
							>
								<MentionInput
									value={replyDraft}
									label="Write a reply"
									placeholder="Write a reply"
									onChange={setReplyDraft}
									onMention={addMention}
								/>
								<div className="comment-form__footer comment-form__footer--start">
									<Button
										type="submit"
										variant="primary"
										size="sm"
										disabled={busy || !replyDraft.trim()}
									>
										Reply
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setReplyTo(null)}
									>
										Cancel
									</Button>
								</div>
							</form>
						) : (
							<button
								type="button"
								className="link-button comment-list__reply"
								onClick={() => {
									setReplyTo(comment.id);
									setReplyDraft("");
								}}
							>
								Reply
							</button>
						)}
					</li>
				))}
			</ul>
		</Card>
	);
}

function CommentBody({
	comment,
	onSeek,
	onDelete,
	formatTime,
}: {
	comment: VideoComment;
	onSeek: (seconds: number) => void;
	onDelete: (comment: VideoComment) => void;
	formatTime: (seconds: number) => string;
}) {
	const timestamp = comment.timestampSeconds;
	return (
		<div className="comment">
			<Avatar name={comment.authorName} size="sm" />
			<div className="comment__content">
				<p className="comment__head">
					<strong className="comment__author">{comment.authorName}</strong>
					<span className="comment__date">{formatDate(comment.createdAt)}</span>
					{timestamp !== null && (
						<button
							type="button"
							className="timeline__time comment__time"
							onClick={() => onSeek(timestamp)}
						>
							{formatTime(timestamp)}
						</button>
					)}
					{comment.canDelete && (
						<button
							type="button"
							className="link-button link-button--danger"
							onClick={() => onDelete(comment)}
						>
							Delete
						</button>
					)}
				</p>
				<p className="comment__text">
					<MentionText text={comment.body} people={comment.mentions} />
				</p>
			</div>
		</div>
	);
}
