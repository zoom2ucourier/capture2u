import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { shownDuration } from "../../shared/timeline";
import type { WatchVideo } from "../../shared/types";
import { ButtonAnchor } from "../components/common/Button";
import { Logo } from "../components/common/Logo";
import { Player } from "../components/Player";
import { ApiRequestError, api } from "../lib/api";

type EmbedState =
	| { kind: "loading" }
	| { kind: "ready"; video: WatchVideo }
	| { kind: "locked" }
	| { kind: "missing" };

export function Embed() {
	const { id = "" } = useParams();
	const [state, setState] = useState<EmbedState>({ kind: "loading" });
	const viewSentRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		viewSentRef.current = false;
		setState({ kind: "loading" });
		api<WatchVideo>(`/api/watch/${id}`, { auth: "optional" })
			.then((video) => {
				if (!cancelled) setState({ kind: "ready", video });
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				const locked =
					cause instanceof ApiRequestError &&
					(cause.code === "restricted" || cause.code === "password_required");
				setState({ kind: locked ? "locked" : "missing" });
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	const shareUrl = `${window.location.origin}/v/${id}`;
	const playback = state.kind === "ready" ? state.video.playback : null;

	if (state.kind === "ready" && playback)
		return (
			<div className="embed">
				<Player
					playback={playback}
					trimStart={state.video.trimStart}
					trimEnd={state.video.trimEnd}
					cuts={state.video.cuts}
					visibleSeconds={shownDuration(state.video)}
					onFirstPlay={() => {
						if (viewSentRef.current) return;
						viewSentRef.current = true;
						void api(`/api/watch/${id}/view`, {
							auth: "optional",
							body: { token: playback.token },
						}).catch(() => undefined);
					}}
				/>
			</div>
		);

	return (
		<div className="embed embed--message">
			{state.kind !== "loading" && <Logo variant="blue" height={32} />}
			<p>
				{state.kind === "loading" && "Loading…"}
				{state.kind === "ready" && "This video is not ready yet."}
				{state.kind === "locked" && "This video is restricted."}
				{state.kind === "missing" &&
					"This video does not exist or has been deleted."}
			</p>
			{state.kind !== "loading" && state.kind !== "missing" && (
				<ButtonAnchor
					variant="primary"
					size="sm"
					href={shareUrl}
					target="_blank"
					rel="noreferrer"
				>
					Open in Capture2u
				</ButtonAnchor>
			)}
		</div>
	);
}
