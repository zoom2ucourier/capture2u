import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	discardRecoverableRecording,
	findRecoverableRecordings,
	type RecoverableRecording,
	recoverRecording,
} from "../recorder/recovery";
import { Button } from "./common/Button";
import { Card } from "./common/Card";
import { Alert } from "./common/Feedback";
import { Icons } from "./common/Icons";

const formatWhen = (timestamp: number) =>
	new Date(timestamp).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
	});

const formatSize = (bytes: number) =>
	bytes >= 1024 * 1024 * 1024
		? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
		: `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export function RecoveryBanner() {
	const navigate = useNavigate();
	const [recordings, setRecordings] = useState<RecoverableRecording[]>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void findRecoverableRecordings().then((found) => {
			if (!cancelled) setRecordings(found);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (recordings.length === 0) return null;

	const recover = async (recording: RecoverableRecording) => {
		setBusyId(recording.sessionId);
		setProgress(0);
		setError(null);
		try {
			const video = await recoverRecording(recording, setProgress);
			navigate(`/v/${video.id}`);
		} catch {
			setError(
				"That recording could not be uploaded. Check your connection and try again.",
			);
			setBusyId(null);
		}
	};

	const discard = async (recording: RecoverableRecording) => {
		if (
			!window.confirm(
				"Delete this unfinished recording from this computer? This cannot be undone.",
			)
		)
			return;
		await discardRecoverableRecording(recording.sessionId).catch(
			() => undefined,
		);
		setRecordings((current) =>
			current.filter((item) => item.sessionId !== recording.sessionId),
		);
	};

	return (
		<Card
			title={
				recordings.length === 1
					? "A recording was not finished"
					: "Some recordings were not finished"
			}
			icon={<Icons.Refresh />}
			className="recovery"
		>
			<p className="field__hint">
				The tab was closed or the browser stopped before the upload finished.
				The recording is still saved on this computer.
			</p>
			{error && <Alert>{error}</Alert>}
			<ul className="recovery__list">
				{recordings.map((recording) => {
					const busy = busyId === recording.sessionId;
					return (
						<li key={recording.sessionId} className="recovery__item">
							<span className="recovery__text">
								Recorded{" "}
								{formatWhen(recording.meta?.startedAt ?? recording.updatedAt)} ·{" "}
								{formatSize(recording.totalBytes)}
							</span>
							{busy ? (
								<span className="recovery__progress">
									<progress className="progress" value={progress} max={1} />
									Uploading {Math.round(progress * 100)}%
								</span>
							) : (
								<span className="recovery__actions">
									<Button
										variant="primary"
										size="sm"
										disabled={busyId !== null}
										startIcon={<Icons.Upload size={14} />}
										onClick={() => void recover(recording)}
									>
										Recover
									</Button>
									<Button
										variant="danger"
										size="sm"
										disabled={busyId !== null}
										onClick={() => void discard(recording)}
									>
										Delete
									</Button>
								</span>
							)}
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
