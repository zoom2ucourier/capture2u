import { describe, expect, it } from "vitest";
import {
	pageLinkAt,
	parsePageLinks,
	shortPageLabel,
} from "../shared/pageLinks";

describe("page links", () => {
	it("keeps web pages in time order and refuses anything else", () => {
		expect(
			parsePageLinks([
				{ url: "https://b.com/x", title: " B ", at: 9 },
				{ url: "https://a.com/", title: "", at: 0 },
			]),
		).toEqual([
			{ url: "https://a.com/", title: null, at: 0 },
			{ url: "https://b.com/x", title: "B", at: 9 },
		]);
		expect(parsePageLinks([{ url: "javascript:alert(1)", at: 0 }])).toBeNull();
		expect(parsePageLinks("nope")).toBeNull();
	});

	it("shows the page that was on screen at a moment", () => {
		const links = [
			{ url: "https://a.com/", title: null, at: 2 },
			{ url: "https://b.com/", title: null, at: 10 },
		];
		expect(pageLinkAt(links, 0)?.url).toBe("https://a.com/");
		expect(pageLinkAt(links, 12)?.url).toBe("https://b.com/");
		expect(pageLinkAt([], 5)).toBeNull();
	});

	it("labels a page by its address without the scheme", () => {
		expect(shortPageLabel("https://www.example.com/orders/1?x=1")).toBe(
			"example.com/orders/1",
		);
	});
});
