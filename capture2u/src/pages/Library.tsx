import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Folder, LibraryVideo } from "../../shared/types";
import { useAuth } from "../auth";
import { ApiRequestError, api, formatDate, formatDuration } from "../lib/api";

const VISIBILITY_LABEL: Record<LibraryVideo["visibility"], string> = {
	public: "Anyone with the link",
	company: "Company only",
	private: "Only me",
};

const NO_FOLDER = "";

export function Library() {
	const { user, setEmailNotifications } = useAuth();
	const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
	const [folders, setFolders] = useState<Folder[]>([]);
	const [folderId, setFolderId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [newFolder, setNewFolder] = useState("");
	const [error, setError] = useState<string | null>(null);

	const loadFolders = useCallback(async () => {
		try {
			const result = await api<{ folders: Folder[] }>("/api/folders");
			setFolders(result.folders);
			setFolderId((current) =>
				current && !result.folders.some((folder) => folder.id === current)
					? null
					: current,
			);
		} catch {
			setError("Could not load your folders.");
		}
	}, []);

	const loadVideos = useCallback(
		async (folder: string | null, term: string) => {
			const params = new URLSearchParams();
			if (folder) params.set("folder", folder);
			if (term) params.set("q", term);
			const suffix = params.size > 0 ? `?${params.toString()}` : "";
			try {
				const result = await api<{ videos: LibraryVideo[] }>(
					`/api/videos${suffix}`,
				);
				setVideos(result.videos);
				setError(null);
			} catch (cause) {
				if (cause instanceof ApiRequestError && cause.status === 404)
					setFolderId(null);
				else setError("Could not load your videos.");
			}
		},
		[],
	);

	useEffect(() => {
		void loadFolders();
	}, [loadFolders]);

	useEffect(() => {
		void loadVideos(folderId, query);
	}, [loadVideos, folderId, query]);

	const refresh = () =>
		Promise.all([loadFolders(), loadVideos(folderId, query)]);

	const updateVideo = async (
		video: LibraryVideo,
		body: Record<string, unknown>,
	) => {
		try {
			await api(`/api/videos/${video.id}`, { method: "PATCH", body });
			await refresh();
		} catch {
			setError("Could not update that video.");
		}
	};

	const removeVideo = async (video: LibraryVideo) => {
		if (!window.confirm(`Delete "${video.title}"? This cannot be undone.`))
			return;
		try {
			await api(`/api/videos/${video.id}`, { method: "DELETE" });
			await refresh();
		} catch {
			setError("Could not delete that video.");
		}
	};

	const createFolder = async () => {
		try {
			const result = await api<{ folder: Folder }>("/api/folders", {
				body: { name: newFolder },
			});
			setNewFolder("");
			await loadFolders();
			setFolderId(result.folder.id);
		} catch (cause) {
			setError(
				cause instanceof ApiRequestError && cause.message
					? cause.message
					: "Could not create that folder.",
			);
		}
	};

	const updateFolder = async (id: string, body: Record<string, unknown>) => {
		try {
			await api(`/api/folders/${id}`, { method: "PATCH", body });
			await loadFolders();
		} catch (cause) {
			setError(
				cause instanceof ApiRequestError && cause.message
					? cause.message
					: "Could not update that folder.",
			);
		}
	};

	const removeFolder = async (folder: Folder) => {
		if (
			!window.confirm(
				`Delete the folder "${folder.name}"? Its videos are kept and go back to My videos.`,
			)
		)
			return;
		try {
			await api(`/api/folders/${folder.id}`, { method: "DELETE" });
			setFolderId(null);
			await loadFolders();
		} catch {
			setError("Could not delete that folder.");
		}
	};

	const selected = folders.find((folder) => folder.id === folderId) ?? null;
	const myFolders = folders.filter((folder) => folder.isOwner);
	const sharedWithMe = folders.filter((folder) => !folder.isOwner);

	return (
		<>
			<div className="page-head">
				<h1>{selected ? selected.name : "My videos"}</h1>
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

			<div className="row folder-bar">
				<button
					type="button"
					className={`button small chip${folderId === null ? " active" : ""}`}
					aria-pressed={folderId === null}
					onClick={() => setFolderId(null)}
				>
					All my videos
				</button>
				{myFolders.map((folder) => (
					<button
						key={folder.id}
						type="button"
						className={`button small chip${folderId === folder.id ? " active" : ""}`}
						aria-pressed={folderId === folder.id}
						onClick={() => setFolderId(folder.id)}
					>
						{folder.name} ({folder.videoCount})
						{folder.shared ? " · Shared" : ""}
					</button>
				))}
				{sharedWithMe.map((folder) => (
					<button
						key={folder.id}
						type="button"
						className={`button small chip${folderId === folder.id ? " active" : ""}`}
						aria-pressed={folderId === folder.id}
						onClick={() => setFolderId(folder.id)}
					>
						{folder.name} ({folder.videoCount}) · {folder.ownerName ?? "Shared"}
					</button>
				))}
				<form
					className="row new-folder"
					onSubmit={(event) => {
						event.preventDefault();
						void createFolder();
					}}
				>
					<input
						type="text"
						maxLength={80}
						placeholder="New folder"
						aria-label="New folder name"
						value={newFolder}
						onChange={(event) => setNewFolder(event.target.value)}
					/>
					<button
						type="submit"
						className="button small"
						disabled={!newFolder.trim()}
					>
						Add folder
					</button>
				</form>
			</div>

			{selected?.isOwner && (
				<FolderSettings
					key={`${selected.id}-${selected.name}`}
					folder={selected}
					onRename={(name) => void updateFolder(selected.id, { name })}
					onShare={(shared) => void updateFolder(selected.id, { shared })}
					onDelete={() => void removeFolder(selected)}
				/>
			)}
			{selected && !selected.isOwner && (
				<p className="muted">
					Shared with the company by {selected.ownerName ?? "a colleague"}.
				</p>
			)}

			{error && <p className="alert">{error}</p>}
			{videos === null && !error && <p className="muted">Loading…</p>}
			{videos?.length === 0 && (
				<div className="card empty">
					<p>
						{query
							? "No videos match that search."
							: selected
								? "This folder is empty."
								: "No recordings yet."}
					</p>
					{!query && !selected && (
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
								{video.isOwner ? "" : `${video.ownerName ?? "A colleague"} · `}
								{formatDate(video.createdAt)} · {video.viewCount}{" "}
								{video.viewCount === 1 ? "view" : "views"} ·{" "}
								{VISIBILITY_LABEL[video.visibility]}
								{video.hasPassword ? " · Password" : ""}
							</p>
							{video.isOwner && (
								<>
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
											onClick={() =>
												void updateVideo(video, { keep: !video.keep })
											}
										>
											{video.keep ? "Stop keeping" : "Keep"}
										</button>
										<button
											type="button"
											className="button ghost small danger"
											onClick={() => void removeVideo(video)}
										>
											Delete
										</button>
										{myFolders.length > 0 && (
											<select
												className="small"
												aria-label={`Folder for ${video.title}`}
												value={video.folderId ?? NO_FOLDER}
												onChange={(event) =>
													void updateVideo(video, {
														folderId: event.target.value || null,
													})
												}
											>
												<option value={NO_FOLDER}>No folder</option>
												{myFolders.map((folder) => (
													<option key={folder.id} value={folder.id}>
														{folder.name}
													</option>
												))}
											</select>
										)}
									</div>
								</>
							)}
						</div>
					</article>
				))}
			</div>

			{user && (
				<label className="choice muted preferences">
					<input
						type="checkbox"
						checked={user.emailNotifications}
						onChange={(event) =>
							void setEmailNotifications(event.target.checked).catch(() =>
								setError("Could not save that setting."),
							)
						}
					/>
					Email me when someone comments on or first watches my videos
				</label>
			)}
		</>
	);
}

function FolderSettings({
	folder,
	onRename,
	onShare,
	onDelete,
}: {
	folder: Folder;
	onRename: (name: string) => void;
	onShare: (shared: boolean) => void;
	onDelete: () => void;
}) {
	const [name, setName] = useState(folder.name);
	const changed = name.trim() !== "" && name.trim() !== folder.name;
	return (
		<div className="card folder-settings">
			<form
				className="row"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) onRename(name.trim());
				}}
			>
				<input
					type="text"
					maxLength={80}
					aria-label="Folder name"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<button type="submit" className="button small" disabled={!changed}>
					Rename
				</button>
				<button
					type="button"
					className="button ghost small danger"
					onClick={onDelete}
				>
					Delete folder
				</button>
			</form>
			<label className="choice">
				<input
					type="checkbox"
					checked={folder.shared}
					onChange={(event) => onShare(event.target.checked)}
				/>
				Share this folder with the company
			</label>
			<p className="muted small-text">
				Signed-in staff can browse a shared folder. Videos set to "Only me" stay
				hidden.
			</p>
		</div>
	);
}
