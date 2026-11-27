import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.resolve(root, "../public/favicon.svg");
const outDir = path.join(root, "public/icons");
const sizes = [16, 32, 48, 128];

const chromeCandidates = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) =>
	existsSync(candidate),
);
if (!executablePath) {
	throw new Error("Chrome was not found. Set CHROME_PATH to its executable.");
}

const svg = await readFile(source, "utf8");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });
try {
	for (const size of sizes) {
		const page = await browser.newPage({
			viewport: { width: size, height: size },
			deviceScaleFactor: 1,
		});
		await page.setContent(
			`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
		);
		const png = await page.screenshot({
			omitBackground: true,
			clip: { x: 0, y: 0, width: size, height: size },
		});
		await writeFile(path.join(outDir, `icon-${size}.png`), png);
		await page.close();
		console.log(`icon-${size}.png (${png.length} bytes)`);
	}
} finally {
	await browser.close();
}
