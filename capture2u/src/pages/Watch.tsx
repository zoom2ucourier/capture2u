import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Visibility, WatchVideo } from "../../shared/types";
import { useAuth } from "../auth";
import { Comments } from "../components/Comments";
import { Button, ButtonAnchor, ButtonLink } from "../components/common/Button";
import { Card } from "../components/common/Card";
import {
	Alert,
	Avatar,
	LoadingState,
	StatusBadge,
} from "../components/common/Feedback";
import { Icons } from "../components/common/Icons";
import { AppHeader } from "../components/layout/AppHeader";
import { GateCard } from "../components/layout/GateCard";
import { Player, type PlayerHandle } from "../components/Player";
import { SignInForm } from "../components/SignInForm";
import { ApiRequestError, api, formatDate, formatDuration } from "../lib/api";

type LoadState =
	| { kind: "loading" }
	| { kind: "ready"; video: WatchVideo }
	| { kind: "password"; wrong: boolean }
	| { kind: "sign-in" }
	| { kind: "private" }
	| { kind: "missing" }
	| { kind: "error" };

const unlockKey = (id: string) => `capture2u-unlock-${id}`;

const isSettled = (video: WatchVideo) =>
	video.status !== "uploading" &&
	video.transcriptStatus !== "pending" &&
	video.transcriptStatus !== "processing" &&
	video.aiStatus !== "pending" &&
	video.aiStatus !== "processing";

const visibleDuration = (video: WatchVideo) => {
	if (!video.isOwner || video.durationSeconds === null)
		return video.durationSeconds;
	return Math.max(
		0,
		Math.min(video.trimEnd ?? video.durationSeconds, video.durationSeconds) -
			(video.trimStart ?? 0),
	);
};

const embedCode = (id: string, title: string) =>
	`<iframe src="${window.location.origin}/embed/${id}" title="${title
		.replace(/&/g, "&amp;")
		.replace(
			/"/g,
			"&quot;",
		)}" width="640" height="360" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;

export function Watch() {
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const { user, loading: authLoading } = useAuth();
	const signedIn = user !== null;
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [password, setPassword] = useState("");
	const [copied, setCopied] = useState<"link" | "embed" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [editingTrim, setEditingTrim] = useState(false);
	const [commentSignIn, setCommentSignIn] = useState(false);
	const playerRef = useRef<PlayerHandle | null>(null);
	const [retrying, setRetrying] = useState(false);
	const viewSentRef = useRef(false);
	const playbackRef = useRef<WatchVideo["playback"]>(null);

	const load = useCallback(
		async (options: { quiet?: boolean } = {}) => {
			if (!options.quiet) setState({ kind: "loading" });
			const unlockToken = sessionStorage.getItem(unlockKey(id));
			try {
				const video = await api<WatchVideo>(`/api/watch/${id}`, {
					auth: signedIn ? "optional" : "none",
					headers: unlockToken ? { "x-unlock-token": unlockToken } : {},
				});
				// Keep the same signed media address across refreshes so the
				// player is not reloaded mid-playback.
				if (playbackRef.current && video.playback)
					video.playback = playbackRef.current;
				else playbackRef.current = video.playback;
				setState({ kind: "ready", video });
			} catch (cause) {
				if (options.quiet) return;
				if (!(cause instanceof ApiRequestError))
					return setState({ kind: "error" });
				if (cause.code === "password_required")
					return setState({ kind: "password", wrong: false });
				if (cause.code === "restricted")
					return setState({
						kind: cause.reason === "private" ? "private" : "sign-in",
					});
				if (cause.status === 404) return setState({ kind: "missing" });
				setState({ kind: "error" });
			}
		},
		[id, signedIn],
	);

	useEffect(() => {
		if (authLoading) return;
		playbackRef.current = null;
		viewSentRef.current = false;
		void load();
	}, [authLoading, load]);

	const video = state.kind === "ready" ? state.video : null;
	const settled = video ? isSettled(video) : true;

	useEffect(() => {
		if (settled) return;
		const interval = window.setInterval(() => void load({ quiet: true }), 6000);
		return () => window.clearInterval(interval);
	}, [load, settled]);

	const unlock = async (event: React.FormEvent) => {
		event.preventDefault();
		try {
			const result = await api<{ unlockToken: string }>(
				`/api/watch/${id}/unlock`,
				{ auth: "none", body: { password } },
			);
			sessionStorage.setItem(unlockKey(id), result.unlockToken);
			setPassword("");
			void load();
		} catch {
			setState({ kind: "password", wrong: true });
		}
	};

	const retryProcessing = async () => {
		setRetrying(true);
		try {
			await api(`/api/videos/${id}/reprocess`, { method: "POST" });
			await load({ quiet: true });
		} catch {
			// The status line keeps saying it failed, so the button stays.
		} finally {
			setRetrying(false);
		}
	};

	const recordView = () => {
		if (viewSentRef.current || !video?.playback) return;
		viewSentRef.current = true;
		void api(`/api/watch/${id}/view`, {
			auth: "optional",
			body: { token: video.playback.token },
		}).catch(() => undefined);
	};

	const seek = (seconds: number) => playerRef.current?.seek(seconds);
	const currentTime = () => playerRef.current?.currentTime() ?? 0;

	const patch = async (body: Record<string, unknown>, done?: string) => {
		let saved = true;
		try {
			await api(`/api/videos/${id}`, { method: "PATCH", body });
			await load({ quiet: true });
			setNotice(done ?? "Saved");
		} catch (cause) {
			saved = false;
			setNotice(
				cause instanceof ApiRequestError && cause.message
					? cause.message
					: "Could not save that change.",
			);
		}
		window.setTimeout(() => setNotice(null), 2500);
		return saved;
	};

	const copy = async (kind: "link" | "embed", text: string) => {
		await navigator.clipboard.writeText(text);
		setCopied(kind);
		window.setTimeout(() => setCopied(null), 2000);
	};

	const remove = async () => {
		if (!window.confirm("Delete this video? This cannot be undone.")) return;
		await api(`/api/videos/${id}`, { method: "DELETE" });
		navigate("/");
	};

	if (state.kind === "loading") return <LoadingState fullScreen />;

	if (state.kind === "password")
		return (
			<GateCard title="Password needed" icon={<Icons.Lock />}>
				<form className="sign-in-form" onSubmit={(event) => void unlock(event)}>
					<p className="sign-in-form__intro">
						This video is protected by a password.
					</p>
					{state.wrong && <Alert>That password is wrong.</Alert>}
					<input
						className="form-input"
						type="password"
						value={password}
						aria-label="Video password"
						onChange={(event) => setPassword(event.target.value)}
					/>
					<Button type="submit" variant="primary" size="lg" fullWidth>
						Watch
					</Button>
				</form>
			</GateCard>
		);

	if (state.kind === "sign-in")
		return (
			<GateCard title="Capture2u">
				<SignInForm intro="Sign in with your work email to watch this video." />
			</GateCard>
		);

	if (state.kind !== "ready")
		return (
			<GateCard
				title={
					state.kind === "private"
						? "Private video"
						: state.kind === "missing"
							? "Video not found"
							: "Something went wrong"
				}
				icon={state.kind === "private" ? <Icons.Lock /> : <Icons.AlertCircle />}
			>
				<p className="sign-in-form__intro">
					{state.kind === "private" && "This video is private to its owner."}
					{state.kind === "missing" &&
						"This video does not exist or has been deleted."}
					{state.kind === "error" &&
						"Something went wrong loading this video. Please try again."}
				</p>
			</GateCard>
		);

	const current = state.video;
	const ownerName = current.ownerName ?? "Unknown";
	return (
		<div className="app">
			<AppHeader>
				{signedIn && (
					<ButtonLink to="/" variant="ghost" startIcon={<Icons.Video />}>
						My videos
					</ButtonLink>
				)}
				<Button
					variant="primary"
					startIcon={copied === "link" ? <Icons.Check /> : <Icons.Link />}
					onClick={() => void copy("link", `${window.location.origin}/v/${id}`)}
				>
					{copied === "link" ? "Copied" : "Copy link"}
				</Button>
			</AppHeader>

			<main className="page watch">
				<section className="watch__main">
					<div className="watch__player">
						{current.playback ? (
							<Player
								ref={playerRef}
								playback={current.playback}
								trimStart={editingTrim ? null : current.trimStart}
								trimEnd={editingTrim ? null : current.trimEnd}
								durationSeconds={current.durationSeconds}
								onFirstPlay={recordView}
							/>
						) : (
							<div className="watch__player-placeholder">
								<StatusBadge
									tone={current.status === "uploading" ? "started" : "failed"}
								>
									{current.status === "uploading" ? "Uploading" : "Failed"}
								</StatusBadge>
								{current.status === "uploading"
									? "This video is still uploading. This page will update when it is ready."
									: "This video failed to upload."}
							</div>
						)}
					</div>

					<div className="watch__heading">
						<TitleEditor
							key={current.title}
							title={current.title}
							editable={current.isOwner}
							onSave={(title) => void patch({ title })}
						/>
						<div className="watch__meta">
							<Avatar name={ownerName} />
							<div>
								<p className="watch__owner">{ownerName}</p>
								<p className="watch__details">
									{formatDate(current.createdAt)} ·{" "}
									{formatDuration(visibleDuration(current))} ·{" "}
									{current.viewCount}{" "}
									{current.viewCount === 1 ? "view" : "views"}
								</p>
							</div>
							<Button
								variant="primary"
								className="watch__copy"
								startIcon={copied === "link" ? <Icons.Check /> : <Icons.Link />}
								onClick={() =>
									void copy("link", `${window.location.origin}/v/${id}`)
								}
							>
								{copied === "link" ? "Copied" : "Copy link"}
							</Button>
						</div>
					</div>

					{current.playback && (
						<div className="watch__toolbar">
							{current.playback.downloadUrl && (
								<ButtonAnchor
									size="sm"
									startIcon={<Icons.Download size={14} />}
									href={current.playback.downloadUrl}
								>
									Download
								</ButtonAnchor>
							)}
							<Button
								size="sm"
								startIcon={
									copied === "embed" ? (
										<Icons.Check size={14} className="icon--complete" />
									) : (
										<Icons.Code size={14} />
									)
								}
								onClick={() =>
									void copy("embed", embedCode(current.id, current.title))
								}
							>
								{copied === "embed" ? "Embed code copied" : "Copy embed code"}
							</Button>
						</div>
					)}

					{current.isOwner && (
						<Card
							title="Sharing"
							icon={<Icons.Share />}
							className="watch__owner-controls"
							actions={notice && <span className="card__notice">{notice}</span>}
						>
							<label className="field">
								<span className="field__label">Who can watch</span>
								<select
									className="form-select"
									value={current.visibility}
									onChange={(event) =>
										void patch({
											visibility: event.target.value as Visibility,
										})
									}
								>
									<option value="public">Anyone with the link</option>
									<option value="company">Company only (signed in)</option>
									<option value="private">Only me</option>
								</select>
							</label>
							<PasswordControl
								hasPassword={current.hasPassword}
								onSave={(value) =>
									void patch(
										{ password: value },
										value ? "Password set" : "Password removed",
									)
								}
							/>
							{current.playback && (
								<TrimControl
									key={`${current.trimStart}-${current.trimEnd}`}
									video={current}
									editing={editingTrim}
									getCurrentTime={currentTime}
									onEditingChange={setEditingTrim}
									onSave={async (trim) => {
										const saved = await patch(
											{ trim },
											trim.start === null && trim.end === null
												? "Trim removed"
												: "Trim saved",
										);
										if (saved) setEditingTrim(false);
									}}
								/>
							)}
							<div className="watch__retention">
								<label className="check">
									<input
										type="checkbox"
										checked={current.keep === true}
										onChange={(event) =>
											void patch({ keep: event.target.checked })
										}
									/>
									Keep this video (never auto-delete)
								</label>
								{current.expiresAt && (
									<p className="field__hint">
										Will be deleted automatically on{" "}
										{formatDate(current.expiresAt)}.
									</p>
								)}
							</div>
							<div className="watch__danger">
								<Button
									variant="danger"
									size="sm"
									startIcon={<Icons.Trash size={14} />}
									onClick={() => void remove()}
								>
									Delete video
								</Button>
							</div>
						</Card>
					)}

					{signedIn ? (
						<Comments
							videoId={current.id}
							unlockToken={sessionStorage.getItem(unlockKey(id))}
							getCurrentTime={currentTime}
							onSeek={seek}
						/>
					) : (
						<Card title="Comments" icon={<Icons.MessageSquare />}>
							{commentSignIn ? (
								<div className="watch__comment-sign-in">
									<SignInForm intro="Sign in with your work email to comment." />
								</div>
							) : (
								<div className="watch__comment-gate">
									<span>Comments are for signed-in staff.</span>
									<Button size="sm" onClick={() => setCommentSignIn(true)}>
										Sign in
									</Button>
								</div>
							)}
						</Card>
					)}
				</section>

				<aside className="watch__side">
					{current.summary && (
						<Card title="Summary" icon={<Icons.AlignLeft />}>
							<p className="watch__summary">{current.summary}</p>
						</Card>
					)}
					{current.chapters.length > 0 && (
						<Card
							title="Chapters"
							icon={<Icons.List />}
							className="card--flush"
						>
							<ul className="timeline">
								{current.chapters.map((chapter) => (
									<li key={`${chapter.start}-${chapter.title}`}>
										<button
											type="button"
											className="timeline__item"
											onClick={() => seek(chapter.start)}
										>
											<span className="timeline__time">
												{formatDuration(chapter.start)}
											</span>
											<span className="timeline__text timeline__text--strong">
												{chapter.title}
											</span>
										</button>
									</li>
								))}
							</ul>
						</Card>
					)}
					<Card
						title="Transcript"
						icon={<Icons.FileText />}
						className={current.transcript.length > 0 ? "card--flush" : ""}
					>
						{current.transcript.length > 0 ? (
							<ul className="timeline timeline--scroll">
								{current.transcript.map((segment) => (
									<li key={`${segment.start}-${segment.end}`}>
										<button
											type="button"
											className="timeline__item"
											onClick={() => seek(segment.start)}
										>
											<span className="timeline__time">
												{formatDuration(segment.start)}
											</span>
											<span className="timeline__text">{segment.text}</span>
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="watch__empty">
								{current.transcriptStatus === "none"
									? "No speech was found in this recording."
									: current.transcriptStatus === "failed"
										? "The transcript could not be created."
										: current.transcriptStatus === "ready"
											? "There is no speech in the part of the video that is shown."
											: "The transcript is being prepared."}
							</p>
						)}
						{current.isOwner &&
							(current.transcriptStatus === "failed" ||
								current.aiStatus === "failed") && (
								<div className="watch__retry">
									<Button
										size="sm"
										startIcon={<Icons.Refresh size={14} />}
										disabled={retrying}
										onClick={() => void retryProcessing()}
									>
										{retrying ? "Starting…" : "Try again"}
									</Button>
								</div>
							)}
					</Card>
				</aside>
			</main>
		</div>
	);
}

function TitleEditor({
	title,
	editable,
	onSave,
}: {
	title: string;
	editable: boolean;
	onSave: (title: string) => void;
}) {
	const [value, setValue] = useState(title);
	if (!editable) return <h1 className="watch__title">{title}</h1>;
	const commit = () => {
		const next = value.trim();
		if (next && next !== title) onSave(next);
		else setValue(title);
	};
	return (
		<input
			className="watch__title watch__title--editable"
			title="Click to rename"
			value={value}
			aria-label="Video title"
			maxLength={200}
			onChange={(event) => setValue(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
}

function TrimControl({
	video,
	editing,
	getCurrentTime,
	onEditingChange,
	onSave,
}: {
	video: WatchVideo;
	editing: boolean;
	getCurrentTime: () => number;
	onEditingChange: (editing: boolean) => void;
	onSave: (trim: { start: number | null; end: number | null }) => void;
}) {
	const [start, setStart] = useState(video.trimStart);
	const [end, setEnd] = useState(video.trimEnd);
	const trimmed = video.trimStart !== null || video.trimEnd !== null;
	const mark = () => Math.round(getCurrentTime() * 10) / 10;

	if (!editing)
		return (
			<div className="field">
				<span className="field__label">Trim</span>
				<p className="field__hint">
					{trimmed
						? `Viewers see ${formatDuration(video.trimStart ?? 0)} to ${formatDuration(video.trimEnd ?? video.durationSeconds)}. The rest is hidden, not deleted.`
						: "Hide the start or the end of this video from viewers."}
				</p>
				<div className="field__row">
					<Button
						size="sm"
						startIcon={<Icons.Scissors size={14} />}
						onClick={() => {
							setStart(video.trimStart);
							setEnd(video.trimEnd);
							onEditingChange(true);
						}}
					>
						{trimmed ? "Change trim" : "Trim"}
					</Button>
					{trimmed && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onSave({ start: null, end: null })}
						>
							Remove trim
						</Button>
					)}
				</div>
			</div>
		);

	return (
		<div className="field field--editing">
			<span className="field__label">Trim</span>
			<p className="field__hint">
				Play or drag the video to the moment you want, then press a button.
			</p>
			<div className="field__row">
				<Button size="sm" onClick={() => setStart(mark())}>
					Start here
				</Button>
				<Button size="sm" onClick={() => setEnd(mark())}>
					End here
				</Button>
			</div>
			<p className="field__value">
				Starts at {formatDuration(start ?? 0)} · Ends at{" "}
				{formatDuration(end ?? video.durationSeconds)}
			</p>
			<div className="field__row">
				<Button
					variant="primary"
					size="sm"
					onClick={() => onSave({ start, end })}
				>
					Save trim
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onEditingChange(false)}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function PasswordControl({
	hasPassword,
	onSave,
}: {
	hasPassword: boolean;
	onSave: (password: string | null) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<div className="field">
			<span className="field__label">
				Password
				<StatusBadge>{hasPassword ? "Set" : "None"}</StatusBadge>
			</span>
			<div className="field__row">
				<input
					className="form-input"
					type="password"
					placeholder={hasPassword ? "New password" : "Add a password"}
					aria-label="Video password"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<Button
					disabled={value.length < 4}
					onClick={() => {
						onSave(value);
						setValue("");
					}}
				>
					Save
				</Button>
				{hasPassword && (
					<Button variant="ghost" onClick={() => onSave(null)}>
						Remove
					</Button>
				)}
			</div>
		</div>
	);
}
