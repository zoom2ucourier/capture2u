import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LibraryVideo } from "../../shared/types";
import { api, formatDate, formatDuration } from "../lib/api";

const VISIBILITY_LABEL: Record<LibraryVideo["visibility"], string> = {
	public: "Anyone with the link",
	company: "Company only",
	private: "Only me",
};

export function Library() {
	const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (term: string) => {
		try {
			const result = await api<{ videos: LibraryVideo[] }>(
				`/api/videos${term ? `?q=${encodeURIComponent(term)}` : ""}`,
			);
			setVideos(result.videos);
			setError(null);
		} catch {
			setError("Could not load your videos.");
		}
	}, []);

	useEffect(() => {
		void load(query);
	}, [load, query]);

	const toggleKeep = async (video: LibraryVideo) => {
		try {
			const result = await api<{ video: LibraryVideo }>(
				`/api/videos/${video.id}`,
				{ method: "PATCH", body: { keep: !video.keep } },
			);
			setVideos(
				(current) =>
					current?.map((item) =>
						item.id === video.id ? result.video : item,
					) ?? null,
			);
		} catch {
			setError("Could not update that video.");
		}
	};

	const remove = async (video: LibraryVideo) => {
		if (!window.confirm(`Delete "${video.title}"? This cannot be undone.`))
			return;
		try {
			await api(`/api/videos/${video.id}`, { method: "DELETE" });
			setVideos(
				(current) => current?.filter((item) => item.id !== video.id) ?? null,
			);
		} catch {
			setError("Could not delete that video.");
		}
	};

	return (
		<>
			<div className="page-head">
				<h1>My videos</h1>
				<form
					className="search"
					onSubmit={(event) => {
						event.preventDefault();
						setQuery(search.trim());
					}}
				>
					<input
						type="search"
						placeholder="Search titles and what was said"
						aria-label="Search videos"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<button type="submit" className="button small">
						Search
					</button>
				</form>
			</div>

			{error && <p className="alert">{error}</p>}
			{videos === null && !error && <p className="muted">Loading…</p>}
			{videos?.length === 0 && (
				<div className="card empty">
					<p>{query ? "No videos match that search." : "No recordings yet."}</p>
					{!query && (
						<Link to="/record" className="button primary">
							Record your first video
						</Link>
					)}
				</div>
			)}

			<div className="grid">
				{videos?.map((video) => (
					<article key={video.id} className="card video-card">
						<Link to={`/v/${video.id}`} className="thumb">
							{video.thumbnailUrl ? (
								<img src={video.thumbnailUrl} alt="" loading="lazy" />
							) : (
								<div className="thumb-placeholder" />
							)}
							{video.status === "ready" ? (
								<span className="badge duration">
									{formatDuration(video.durationSeconds)}
								</span>
							) : (
								<span className="badge warn">
									{video.status === "uploading" ? "Uploading" : "Failed"}
								</span>
							)}
						</Link>
						<div className="video-meta">
							<Link to={`/v/${video.id}`} className="video-title">
								{video.title}
							</Link>
							<p className="muted small-text">
								{formatDate(video.createdAt)} · {video.viewCount}{" "}
								{video.viewCount === 1 ? "view" : "views"} ·{" "}
								{VISIBILITY_LABEL[video.visibility]}
								{video.hasPassword ? " · Password" : ""}
							</p>
							<p className="muted small-text">
								{video.keep
									? "Kept. Will not be auto-deleted."
									: video.expiresAt
										? `Auto-deletes ${formatDate(video.expiresAt)}`
										: ""}
							</p>
							<div className="row">
								<button
									type="button"
									className="button ghost small"
									onClick={() => void toggleKeep(video)}
								>
									{video.keep ? "Stop keeping" : "Keep"}
								</button>
								<button
									type="button"
									className="button ghost small danger"
									onClick={() => void remove(video)}
								>
									Delete
								</button>
							</div>
						</div>
					</article>
				))}
			</div>
		</>
	);
}
