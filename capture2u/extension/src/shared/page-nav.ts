import {
	BRAND_LOGO_MARKUP,
	BRAND_LOGO_VIEW_BOX,
	BRAND_NAME,
} from "./brand-markup";
import { openRequestedRecorder } from "./recorder-host";
import { RECORDER_HOST_PAGE } from "./recorder-pages";
import { DEFAULT_API_BASE_URL, loadSettings } from "./storage";

export const PAGE_NAV_LINKS = [
	{ id: "recorder", label: "Recorder", href: RECORDER_HOST_PAGE },
	{ id: "camera", label: "Camera access", href: "camera-permission.html" },
	{ id: "options", label: "Options", href: "options.html" },
] as const;

export type PageNavId = (typeof PAGE_NAV_LINKS)[number]["id"];

const LOGO_SVG = `<svg class="page-nav-logo" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="${BRAND_LOGO_VIEW_BOX}" aria-hidden="true">${BRAND_LOGO_MARKUP}</svg>`;

export const mountPageNav = (active: PageNavId) => {
	if (document.querySelector(".page-nav")) return;
	openRequestedRecorder();

	const nav = document.createElement("nav");
	nav.className = "page-nav";
	nav.setAttribute("aria-label", `${BRAND_NAME} extension pages`);

	const inner = document.createElement("div");
	inner.className = "page-nav-inner";

	const brand = document.createElement("a");
	brand.className = "page-nav-brand";
	brand.href = RECORDER_HOST_PAGE;
	brand.setAttribute("aria-label", BRAND_NAME);
	brand.innerHTML = LOGO_SVG;

	const links = document.createElement("div");
	links.className = "page-nav-links";
	for (const link of PAGE_NAV_LINKS) {
		const anchor = document.createElement("a");
		anchor.className =
			link.id === active ? "page-nav-link is-active" : "page-nav-link";
		anchor.href = link.href;
		anchor.textContent = link.label;
		if (link.id === active) {
			anchor.setAttribute("aria-current", "page");
		}
		links.append(anchor);
	}

	const library = document.createElement("a");
	library.className = "page-nav-link";
	library.href = new URL("/", DEFAULT_API_BASE_URL).toString();
	library.target = "_blank";
	library.rel = "noopener";
	library.textContent = "My videos";
	links.append(library);
	// The address can be overridden in Options for local testing, so resolve
	// the real one once settings load and leave the default until then.
	void loadSettings()
		.then((settings) => {
			library.href = new URL("/", settings.apiBaseUrl).toString();
		})
		.catch(() => undefined);

	inner.append(brand, links);
	nav.append(inner);
	document.body.prepend(nav);
};
