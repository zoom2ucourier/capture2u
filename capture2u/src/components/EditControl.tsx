import { useState } from "react";
import {
	keptRanges,
	keptTotal,
	mergeRanges,
	type TimeRange,
	uncoveredRanges,
} from "../../shared/timeline";
import type { WatchVideo } from "../../shared/types";
import { formatDuration } from "../lib/api";
import { Button } from "./common/Button";
import { Icons } from "./common/Icons";

export interface VideoEdits {
	trim: { start: number | null; end: number | null };
	cuts: TimeRange[];
}

const rangesLength = (ranges: TimeRange[]) =>
	ranges.reduce((total, range) => total + (range.end - range.start), 0);

const shortLength = (seconds: number) =>
	seconds < 60
		? `${Math.max(1, Math.round(seconds))} sec`
		: formatDuration(seconds);

function SuggestionButtons({
	video,
	cuts,
	onAdd,
}: {
	video: WatchVideo;
	cuts: TimeRange[];
	onAdd: (ranges: TimeRange[], done: string) => void;
}) {
	const silences = uncoveredRanges(video.suggestedCuts?.silences ?? [], cuts);
	const fillers = uncoveredRanges(video.suggestedCuts?.fillers ?? [], cuts);
	if (silences.length === 0 && fillers.length === 0) return null;
	return (
		<div className="field__row">
			{silences.length > 0 && (
				<Button
					size="sm"
					startIcon={<Icons.Sparkles size={14} />}
					onClick={() => onAdd(silences, "Pauses removed")}
				>
					Remove {silences.length} {silences.length === 1 ? "pause" : "pauses"}{" "}
					({shortLength(rangesLength(silences))})
				</Button>
			)}
			{fillers.length > 0 && (
				<Button
					size="sm"
					startIcon={<Icons.Sparkles size={14} />}
					onClick={() => onAdd(fillers, "Ums and uhs removed")}
				>
					Remove {fillers.length} {fillers.length === 1 ? "um" : "ums and uhs"}
				</Button>
			)}
		</div>
	);
}

export function EditControl({
	video,
	editing,
	getCurrentTime,
	onEditingChange,
	onDraftCutsChange,
	onSave,
}: {
	video: WatchVideo;
	editing: boolean;
	getCurrentTime: () => number;
	onEditingChange: (editing: boolean) => void;
	onDraftCutsChange: (cuts: TimeRange[]) => void;
	onSave: (edits: VideoEdits, done: string) => void;
}) {
	const [start, setStart] = useState(video.trimStart);
	const [end, setEnd] = useState(video.trimEnd);
	const [cuts, setCuts] = useState<TimeRange[]>(video.cuts);
	const [cutFrom, setCutFrom] = useState<number | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	const duration = video.durationSeconds ?? 0;
	const edited =
		video.trimStart !== null || video.trimEnd !== null || video.cuts.length > 0;
	const mark = () => Math.round(getCurrentTime() * 10) / 10;

	const changeCuts = (next: TimeRange[]) => {
		const merged = mergeRanges(next, 0.1);
		setCuts(merged);
		onDraftCutsChange(merged);
	};

	const open = () => {
		setStart(video.trimStart);
		setEnd(video.trimEnd);
		setCuts(video.cuts);
		setCutFrom(null);
		setProblem(null);
		onDraftCutsChange(video.cuts);
		onEditingChange(true);
	};

	if (!editing) {
		const shown = duration
			? keptTotal(
					keptRanges(duration, video.trimStart, video.trimEnd, video.cuts),
				)
			: null;
		return (
			<div className="field">
				<span className="field__label">Edit</span>
				<p className="field__hint">
					{edited
						? `Viewers see ${shown === null ? "part" : formatDuration(shown)} of this ${formatDuration(duration)} video${
								video.cuts.length > 0
									? `, with ${video.cuts.length} ${video.cuts.length === 1 ? "section" : "sections"} cut out`
									: ""
							}. The rest is hidden, not deleted.`
						: "Trim the ends or cut sections out of the middle. Nothing is deleted, so you can undo it."}
				</p>
				<div className="field__row">
					<Button
						size="sm"
						startIcon={<Icons.Scissors size={14} />}
						onClick={open}
					>
						{edited ? "Change edits" : "Trim or cut"}
					</Button>
					{edited && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() =>
								onSave(
									{ trim: { start: null, end: null }, cuts: [] },
									"Edits removed",
								)
							}
						>
							Undo all edits
						</Button>
					)}
				</div>
				<SuggestionButtons
					video={video}
					cuts={video.cuts}
					onAdd={(ranges, done) =>
						onSave(
							{
								trim: { start: video.trimStart, end: video.trimEnd },
								cuts: mergeRanges([...video.cuts, ...ranges], 0.1),
							},
							done,
						)
					}
				/>
			</div>
		);
	}

	const finishCut = () => {
		const to = mark();
		if (cutFrom === null) return;
		const from = Math.min(cutFrom, to);
		const until = Math.max(cutFrom, to);
		if (until - from < 0.2) {
			setProblem("Move the video forward before ending the cut.");
			return;
		}
		setProblem(null);
		setCutFrom(null);
		changeCuts([...cuts, { start: from, end: until }]);
	};

	return (
		<div className="field field--editing">
			<span className="field__label">Edit</span>
			<p className="field__hint">
				Play or drag the video to the moment you want, then press a button. The
				red marks on the video bar are the sections you have cut.
			</p>
			<div className="field__row">
				<Button size="sm" onClick={() => setStart(mark())}>
					Start here
				</Button>
				<Button size="sm" onClick={() => setEnd(mark())}>
					End here
				</Button>
				{cutFrom === null ? (
					<Button
						size="sm"
						startIcon={<Icons.Scissors size={14} />}
						onClick={() => {
							setProblem(null);
							setCutFrom(mark());
						}}
					>
						Cut from here
					</Button>
				) : (
					<>
						<Button
							variant="primary"
							size="sm"
							startIcon={<Icons.Scissors size={14} />}
							onClick={finishCut}
						>
							Cut to here
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setCutFrom(null)}>
							Cancel cut
						</Button>
					</>
				)}
			</div>
			<p className="field__value">
				Starts at {formatDuration(start ?? 0)} · Ends at{" "}
				{formatDuration(end ?? duration)}
				{cutFrom !== null && ` · Cutting from ${formatDuration(cutFrom)}…`}
			</p>
			{problem && <p className="field__hint field__hint--problem">{problem}</p>}
			{cuts.length > 0 && (
				<ul className="cut-list">
					{cuts.map((cut) => (
						<li key={`${cut.start}-${cut.end}`} className="cut-list__item">
							<Icons.Scissors size={13} />
							{formatDuration(cut.start)} to {formatDuration(cut.end)}
							<button
								type="button"
								className="cut-list__remove"
								aria-label={`Keep ${formatDuration(cut.start)} to ${formatDuration(cut.end)}`}
								title="Keep this section"
								onClick={() => changeCuts(cuts.filter((item) => item !== cut))}
							>
								<Icons.X size={13} />
							</button>
						</li>
					))}
				</ul>
			)}
			<SuggestionButtons
				video={video}
				cuts={cuts}
				onAdd={(ranges) => changeCuts([...cuts, ...ranges])}
			/>
			<div className="field__row">
				<Button
					variant="primary"
					size="sm"
					onClick={() => onSave({ trim: { start, end }, cuts }, "Edits saved")}
				>
					Save edits
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
