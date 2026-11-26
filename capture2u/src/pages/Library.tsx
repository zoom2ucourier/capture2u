import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Folder, LibraryVideo } from "../../shared/types";
import { Button, ButtonLink } from "../components/common/Button";
import { Card } from "../components/common/Card";
import { Alert, EmptyState, LoadingState } from "../components/common/Feedback";
import { Icons } from "../components/common/Icons";
import { ApiRequestError, api, formatDate, formatDuration } from "../lib/api";

const VISIBILITY_LABEL: Record<LibraryVideo["visibility"], string> = {
	public: "Anyone with the link",
	company: "Company only",
	private: "Only me",
};

const VISIBILITY_ICON: Record<LibraryVideo["visibility"], typeof Icons.Globe> =
	{
		public: Icons.Globe,
		company: Icons.Briefcase,
		private: Icons.Lock,
	};

const NO_FOLDER = "";

const countLabel = (count: number) =>
	`${count} ${count === 1 ? "video" : "videos"}`;

export function Library() {
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

	const subtitle =
		selected && !selected.isOwner
			? `Shared with the company by ${selected.ownerName ?? "a colleague"}`
			: videos
				? countLabel(videos.length)
				: "";

	return (
		<div className="library">
			<div className="page-head">
				<div className="page-head__text">
					<h1 className="page-head__title">
						{selected ? selected.name : "My videos"}
					</h1>
					{subtitle && <p className="page-head__subtitle">{subtitle}</p>}
				</div>
				<form
					className="search"
					onSubmit={(event) => {
						event.preventDefault();
						setQuery(search.trim());
					}}
				>
					<div className="search__field">
						<Icons.Search className="search__icon" />
						<input
							className="form-input search__input"
							type="search"
							placeholder="Search titles and what was said"
							aria-label="Search videos"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</div>
					<Button type="submit">Search</Button>
				</form>
			</div>

			<div className="folder-bar">
				<button
					type="button"
					className={`chip${folderId === null ? " chip--active" : ""}`}
					aria-pressed={folderId === null}
					onClick={() => setFolderId(null)}
				>
					<Icons.Video size={14} />
					All my videos
				</button>
				{myFolders.map((folder) => (
					<button
						key={folder.id}
						type="button"
						className={`chip${folderId === folder.id ? " chip--active" : ""}`}
						aria-pressed={folderId === folder.id}
						onClick={() => setFolderId(folder.id)}
					>
						<Icons.Folder size={14} />
						{folder.name}
						<span className="chip__count">{folder.videoCount}</span>
						{folder.shared && (
							<span className="chip__note">
								<Icons.Users size={12} />
								Shared
							</span>
						)}
					</button>
				))}
				{sharedWithMe.map((folder) => (
					<button
						key={folder.id}
						type="button"
						className={`chip${folderId === folder.id ? " chip--active" : ""}`}
						aria-pressed={folderId === folder.id}
						onClick={() => setFolderId(folder.id)}
					>
						<Icons.Users size={14} />
						{folder.name}
						<span className="chip__count">{folder.videoCount}</span>
						<span className="chip__note">{folder.ownerName ?? "Shared"}</span>
					</button>
				))}
				<form
					className="folder-bar__new"
					onSubmit={(event) => {
						event.preventDefault();
						void createFolder();
					}}
				>
					<input
						className="form-input form-input--sm"
						type="text"
						maxLength={80}
						placeholder="New folder"
						aria-label="New folder name"
						value={newFolder}
						onChange={(event) => setNewFolder(event.target.value)}
					/>
					<Button
						type="submit"
						size="sm"
						startIcon={<Icons.Plus size={14} />}
						disabled={!newFolder.trim()}
					>
						Add folder
					</Button>
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

			{error && <Alert>{error}</Alert>}
			{videos === null && !error && <LoadingState />}
			{videos?.length === 0 && (
				<div className="card">
					<EmptyState
						icon={query ? <Icons.Search /> : <Icons.Video />}
						title={
							query
								? "No videos match that search."
								: selected
									? "This folder is empty."
									: "No recordings yet."
						}
						action={
							!query && !selected ? (
								<ButtonLink
									to="/record"
									variant="primary"
									startIcon={<Icons.Record />}
								>
									Record your first video
								</ButtonLink>
							) : undefined
						}
					/>
				</div>
			)}

			<div className="video-grid">
				{videos?.map((video) => {
					const VisibilityIcon = VISIBILITY_ICON[video.visibility];
					return (
						<article key={video.id} className="video-card">
							<Link to={`/v/${video.id}`} className="video-card__thumb">
								{video.thumbnailUrl ? (
									<img src={video.thumbnailUrl} alt="" loading="lazy" />
								) : (
									<div className="video-card__placeholder">
										<Icons.Video size={32} />
									</div>
								)}
								{video.status === "ready" ? (
									<span className="video-card__badge">
										{formatDuration(video.durationSeconds)}
									</span>
								) : (
									<span
										className={`video-card__badge video-card__badge--${
											video.status === "uploading" ? "started" : "failed"
										}`}
									>
										{video.status === "uploading" ? "Uploading" : "Failed"}
									</span>
								)}
							</Link>
							<div className="video-card__body">
								<Link to={`/v/${video.id}`} className="video-card__title">
									{video.title}
								</Link>
								<p className="video-card__meta">
									{video.isOwner
										? ""
										: `${video.ownerName ?? "A colleague"} · `}
									{formatDate(video.createdAt)} · {video.viewCount}{" "}
									{video.viewCount === 1 ? "view" : "views"}
								</p>
								<p className="video-card__meta video-card__meta--icon">
									<VisibilityIcon size={13} />
									{VISIBILITY_LABEL[video.visibility]}
									{video.hasPassword ? " · Password" : ""}
								</p>
								{video.isOwner && (video.keep || video.expiresAt) && (
									<p className="video-card__meta video-card__meta--icon">
										{video.keep ? (
											<Icons.Bookmark size={13} />
										) : (
											<Icons.Clock size={13} />
										)}
										{video.keep
											? "Kept. Will not be auto-deleted."
											: video.expiresAt
												? `Auto-deletes ${formatDate(video.expiresAt)}`
												: ""}
									</p>
								)}
							</div>
							{video.isOwner && (
								<div className="video-card__footer">
									{myFolders.length > 0 && (
										<select
											className="form-select form-select--sm"
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
									<div className="video-card__actions">
										<Button
											variant="ghost"
											size="sm"
											active={video.keep}
											startIcon={<Icons.Bookmark size={14} />}
											onClick={() =>
												void updateVideo(video, { keep: !video.keep })
											}
										>
											{video.keep ? "Stop keeping" : "Keep"}
										</Button>
										<Button
											variant="danger"
											size="sm"
											iconOnly
											aria-label={`Delete ${video.title}`}
											title="Delete"
											onClick={() => void removeVideo(video)}
										>
											<Icons.Trash size={14} />
										</Button>
									</div>
								</div>
							)}
						</article>
					);
				})}
			</div>
		</div>
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
		<Card
			title="Folder settings"
			icon={<Icons.Folder />}
			className="folder-settings"
		>
			<form
				className="folder-settings__row"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) onRename(name.trim());
				}}
			>
				<input
					className="form-input"
					type="text"
					maxLength={80}
					aria-label="Folder name"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<Button type="submit" disabled={!changed}>
					Rename
				</Button>
				<Button
					variant="danger"
					startIcon={<Icons.Trash size={14} />}
					onClick={onDelete}
				>
					Delete folder
				</Button>
			</form>
			<label className="check">
				<input
					type="checkbox"
					checked={folder.shared}
					onChange={(event) => onShare(event.target.checked)}
				/>
				Share this folder with the company
			</label>
			<p className="field__hint">
				Signed-in staff can browse a shared folder. Videos set to "Only me" stay
				hidden.
			</p>
		</Card>
	);
}
