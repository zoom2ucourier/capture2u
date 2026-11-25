import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Visibility, WatchVideo } from "../../shared/types";
import { useAuth } from "../auth";
import { Comments } from "../components/Comments";
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
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

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
	const [speed, setSpeed] = useState(1);
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

	if (state.kind === "loading")
		return <main className="center-screen muted">Loading…</main>;

	if (state.kind !== "ready")
		return (
			<main className="center-screen">
				<div className="card sign-in">
					<h1>Capture2u</h1>
					{state.kind === "password" && (
						<form onSubmit={(event) => void unlock(event)}>
							<p>This video is protected by a password.</p>
							{state.wrong && <p className="alert">That password is wrong.</p>}
							<input
								type="password"
								value={password}
								aria-label="Video password"
								onChange={(event) => setPassword(event.target.value)}
							/>
							<button type="submit" className="button primary">
								Watch
							</button>
						</form>
					)}
					{state.kind === "sign-in" && (
						<SignInForm intro="Sign in with your work email to watch this video." />
					)}
					{state.kind === "private" && (
						<p>This video is private to its owner.</p>
					)}
					{state.kind === "missing" && (
						<p>This video does not exist or has been deleted.</p>
					)}
					{state.kind === "error" && (
						<p>Something went wrong loading this video. Please try again.</p>
					)}
				</div>
			</main>
		);

	const current = state.video;
	return (
		<div className="watch">
			<header className="topbar">
				<Link to="/" className="brand">
					Capture2u
				</Link>
				<nav>
					<button
						type="button"
						className="button small"
						onClick={() =>
							void copy("link", `${window.location.origin}/v/${id}`)
						}
					>
						{copied === "link" ? "Copied" : "Copy link"}
					</button>
				</nav>
			</header>

			<main className="page watch-layout">
				<section>
					<div className="player">
						{current.playback ? (
							<Player
								ref={playerRef}
								playback={current.playback}
								trimStart={editingTrim ? null : current.trimStart}
								trimEnd={editingTrim ? null : current.trimEnd}
								speed={speed}
								onFirstPlay={recordView}
							/>
						) : (
							<div className="player-placeholder">
								{current.status === "uploading"
									? "This video is still uploading. This page will update when it is ready."
									: "This video failed to upload."}
							</div>
						)}
					</div>

					<TitleEditor
						key={current.title}
						title={current.title}
						editable={current.isOwner}
						onSave={(title) => void patch({ title })}
					/>
					<p className="muted small-text">
						{current.ownerName ?? "Unknown"} · {formatDate(current.createdAt)} ·{" "}
						{formatDuration(visibleDuration(current))} · {current.viewCount}{" "}
						{current.viewCount === 1 ? "view" : "views"}
					</p>

					{current.playback && (
						<div className="row">
							<label className="field inline">
								Speed
								<select
									value={speed}
									onChange={(event) => setSpeed(Number(event.target.value))}
								>
									{SPEEDS.map((value) => (
										<option key={value} value={value}>
											{value}x
										</option>
									))}
								</select>
							</label>
							{current.playback.downloadUrl && (
								<a
									className="button ghost small"
									href={current.playback.downloadUrl}
								>
									Download
								</a>
							)}
							<button
								type="button"
								className="button ghost small"
								onClick={() =>
									void copy("embed", embedCode(current.id, current.title))
								}
							>
								{copied === "embed" ? "Embed code copied" : "Copy embed code"}
							</button>
						</div>
					)}

					{current.isOwner && (
						<div className="card owner-controls">
							<h2>Sharing</h2>
							<label className="field">
								Who can watch
								<select
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
							<label className="choice">
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
								<p className="muted small-text">
									Will be deleted automatically on{" "}
									{formatDate(current.expiresAt)}.
								</p>
							)}
							<button
								type="button"
								className="button ghost small danger"
								onClick={() => void remove()}
							>
								Delete video
							</button>
							{notice && <p className="muted small-text">{notice}</p>}
						</div>
					)}

					{signedIn ? (
						<Comments
							videoId={current.id}
							unlockToken={sessionStorage.getItem(unlockKey(id))}
							getCurrentTime={currentTime}
							onSeek={seek}
						/>
					) : (
						<div className="card comments">
							<h2>Comments</h2>
							{commentSignIn ? (
								<div className="sign-in inline-sign-in">
									<SignInForm intro="Sign in with your work email to comment." />
								</div>
							) : (
								<div className="row">
									<span className="muted">
										Comments are for signed-in staff.
									</span>
									<button
										type="button"
										className="button small"
										onClick={() => setCommentSignIn(true)}
									>
										Sign in
									</button>
								</div>
							)}
						</div>
					)}
				</section>

				<aside>
					{current.summary && (
						<div className="card">
							<h2>Summary</h2>
							<p>{current.summary}</p>
						</div>
					)}
					{current.chapters.length > 0 && (
						<div className="card">
							<h2>Chapters</h2>
							<ul className="timeline">
								{current.chapters.map((chapter) => (
									<li key={`${chapter.start}-${chapter.title}`}>
										<button type="button" onClick={() => seek(chapter.start)}>
											<span className="time">
												{formatDuration(chapter.start)}
											</span>
											{chapter.title}
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					<div className="card">
						<h2>Transcript</h2>
						{current.transcript.length > 0 ? (
							<ul className="timeline transcript">
								{current.transcript.map((segment) => (
									<li key={`${segment.start}-${segment.end}`}>
										<button type="button" onClick={() => seek(segment.start)}>
											<span className="time">
												{formatDuration(segment.start)}
											</span>
											{segment.text}
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="muted">
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
								<button
									type="button"
									className="button small"
									disabled={retrying}
									onClick={() => void retryProcessing()}
								>
									{retrying ? "Starting…" : "Try again"}
								</button>
							)}
					</div>
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
	if (!editable) return <h1 className="watch-title">{title}</h1>;
	const commit = () => {
		const next = value.trim();
		if (next && next !== title) onSave(next);
		else setValue(title);
	};
	return (
		<input
			className="watch-title editable"
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
				Trim
				<p className="muted small-text">
					{trimmed
						? `Viewers see ${formatDuration(video.trimStart ?? 0)} to ${formatDuration(video.trimEnd ?? video.durationSeconds)}. The rest is hidden, not deleted.`
						: "Hide the start or the end of this video from viewers."}
				</p>
				<div className="row">
					<button
						type="button"
						className="button small"
						onClick={() => {
							setStart(video.trimStart);
							setEnd(video.trimEnd);
							onEditingChange(true);
						}}
					>
						{trimmed ? "Change trim" : "Trim"}
					</button>
					{trimmed && (
						<button
							type="button"
							className="button ghost small"
							onClick={() => onSave({ start: null, end: null })}
						>
							Remove trim
						</button>
					)}
				</div>
			</div>
		);

	return (
		<div className="field">
			Trim
			<p className="muted small-text">
				Play or drag the video to the moment you want, then press a button.
			</p>
			<div className="row">
				<button
					type="button"
					className="button small"
					onClick={() => setStart(mark())}
				>
					Start here
				</button>
				<button
					type="button"
					className="button small"
					onClick={() => setEnd(mark())}
				>
					End here
				</button>
			</div>
			<p className="small-text">
				Starts at {formatDuration(start ?? 0)} · Ends at{" "}
				{formatDuration(end ?? video.durationSeconds)}
			</p>
			<div className="row">
				<button
					type="button"
					className="button primary small"
					onClick={() => onSave({ start, end })}
				>
					Save trim
				</button>
				<button
					type="button"
					className="button ghost small"
					onClick={() => onEditingChange(false)}
				>
					Cancel
				</button>
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
			Password {hasPassword ? "(set)" : "(none)"}
			<div className="row">
				<input
					type="password"
					placeholder={hasPassword ? "New password" : "Add a password"}
					aria-label="Video password"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<button
					type="button"
					className="button small"
					disabled={value.length < 4}
					onClick={() => {
						onSave(value);
						setValue("");
					}}
				>
					Save
				</button>
				{hasPassword && (
					<button
						type="button"
						className="button ghost small"
						onClick={() => onSave(null)}
					>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}
