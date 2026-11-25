import { useCallback, useEffect, useMemo, useState } from "react";
import { REACTION_EMOJI, type VideoComment } from "../../shared/types";
import { api, formatDate, formatDuration } from "../lib/api";

interface CommentsProps {
	videoId: string;
	unlockToken: string | null;
	getCurrentTime: () => number;
	onSeek: (seconds: number) => void;
}

export function Comments({
	videoId,
	unlockToken,
	getCurrentTime,
	onSeek,
}: CommentsProps) {
	const [comments, setComments] = useState<VideoComment[] | null>(null);
	const [draft, setDraft] = useState("");
	const [atCurrentTime, setAtCurrentTime] = useState(true);
	const [replyTo, setReplyTo] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
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
		<div className="card comments">
			<h2>Comments</h2>
			{error && <p className="alert">{error}</p>}

			<div className="row reactions">
				{REACTION_EMOJI.map((emoji) => {
					const matching = reactions.filter(
						(reaction) => reaction.body === emoji,
					);
					const mine = matching.some((reaction) => reaction.isMine);
					return (
						<button
							key={emoji}
							type="button"
							className={`button small reaction${mine ? " active" : ""}`}
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
							{matching.length > 0 && <span>{matching.length}</span>}
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
					}).then((saved) => {
						if (saved) setDraft("");
					});
				}}
			>
				<textarea
					rows={2}
					maxLength={4000}
					placeholder="Add a comment"
					aria-label="Add a comment"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="row">
					<label className="choice">
						<input
							type="checkbox"
							checked={atCurrentTime}
							onChange={(event) => setAtCurrentTime(event.target.checked)}
						/>
						Link to the current moment
					</label>
					<button
						type="submit"
						className="button primary small"
						disabled={busy || !draft.trim()}
					>
						Comment
					</button>
				</div>
			</form>

			{comments === null && !error && <p className="muted">Loading…</p>}
			{comments !== null && threads.length === 0 && (
				<p className="muted">No comments yet.</p>
			)}

			<ul className="comment-list">
				{threads.map((comment) => (
					<li key={comment.id}>
						<CommentBody comment={comment} onSeek={onSeek} onDelete={remove} />
						<ul className="comment-list replies">
							{repliesTo(comment.id).map((reply) => (
								<li key={reply.id}>
									<CommentBody
										comment={reply}
										onSeek={onSeek}
										onDelete={remove}
									/>
								</li>
							))}
						</ul>
						{replyTo === comment.id ? (
							<form
								className="comment-form replies"
								onSubmit={(event) => {
									event.preventDefault();
									void post({
										kind: "text",
										body: replyDraft,
										parentId: comment.id,
									}).then((saved) => {
										if (!saved) return;
										setReplyDraft("");
										setReplyTo(null);
									});
								}}
							>
								<textarea
									rows={2}
									maxLength={4000}
									placeholder="Write a reply"
									aria-label="Write a reply"
									value={replyDraft}
									onChange={(event) => setReplyDraft(event.target.value)}
								/>
								<div className="row">
									<button
										type="submit"
										className="button primary small"
										disabled={busy || !replyDraft.trim()}
									>
										Reply
									</button>
									<button
										type="button"
										className="button ghost small"
										onClick={() => setReplyTo(null)}
									>
										Cancel
									</button>
								</div>
							</form>
						) : (
							<button
								type="button"
								className="link-button replies"
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
		</div>
	);
}

function CommentBody({
	comment,
	onSeek,
	onDelete,
}: {
	comment: VideoComment;
	onSeek: (seconds: number) => void;
	onDelete: (comment: VideoComment) => void;
}) {
	const timestamp = comment.timestampSeconds;
	return (
		<div className="comment">
			<p className="small-text">
				<strong>{comment.authorName}</strong>{" "}
				<span className="muted">{formatDate(comment.createdAt)}</span>
				{timestamp !== null && (
					<button
						type="button"
						className="link-button time"
						onClick={() => onSeek(timestamp)}
					>
						{formatDuration(timestamp)}
					</button>
				)}
				{comment.canDelete && (
					<button
						type="button"
						className="link-button danger"
						onClick={() => onDelete(comment)}
					>
						Delete
					</button>
				)}
			</p>
			<p className="comment-text">{comment.body}</p>
		</div>
	);
}
