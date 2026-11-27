import { mountPageNav } from "../shared/page-nav";
import {
	RECORDER_FIRST_RUN_PARAM,
	RECORDER_OPEN_PARAM,
} from "../shared/recorder-pages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import "./styles.css";

const TOGGLE_RECORDING_COMMAND = "toggle-recording";

// Read before the page nav drops the flag from the URL.
const params = new URLSearchParams(window.location.search);
const openedForRecorder = params.get(RECORDER_OPEN_PARAM) === "open";
const firstRun = params.has(RECORDER_FIRST_RUN_PARAM);

const reveal = (id: string) => {
	const element = document.getElementById(id);
	if (element) element.hidden = false;
};

if (firstRun) reveal("installed-note");
else if (openedForRecorder) reveal("recorder-note");

document.getElementById("open-recorder")?.addEventListener("click", () => {
	void sendServiceWorkerMessage({
		target: "service-worker",
		type: "show-recorder-panel",
	}).catch(() => undefined);
});

// The shortcut is only a suggestion to Chrome: it stays unassigned when
// another extension already uses it, and people can change it. Show the real
// one, or where to set it.
chrome.commands.getAll((commands) => {
	const shortcut = document.getElementById("shortcut");
	if (chrome.runtime.lastError || !shortcut) return;
	const assigned = commands.find(
		(command) => command.name === TOGGLE_RECORDING_COMMAND,
	)?.shortcut;
	if (assigned) {
		shortcut.textContent = assigned;
		return;
	}
	const hint = shortcut.parentElement;
	if (hint) {
		hint.textContent =
			"Set a keyboard shortcut for starting and stopping a recording at chrome://extensions/shortcuts.";
	}
});

mountPageNav("recorder");
