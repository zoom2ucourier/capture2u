// Browser pages (New Tab, settings, the Web Store) cannot run content
// scripts, so the in-page recorder cannot open there. Capture2u's own pages
// load the same overlay a website gets, so the recorder always has somewhere
// to open, including the page a new user lands on after installing.
export const RECORDER_HOST_PAGE = "recorder.html";

const RECORDER_HOST_PATHS = new Set([
	`/${RECORDER_HOST_PAGE}`,
	"/camera-permission.html",
	"/options.html",
]);

export const RECORDER_OPEN_PARAM = "recorder";
export const RECORDER_FIRST_RUN_PARAM = "installed";

export const isRecorderHostPage = (url: string | undefined) => {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === new URL(chrome.runtime.getURL("")).origin &&
			RECORDER_HOST_PATHS.has(parsed.pathname)
		);
	} catch {
		return false;
	}
};
