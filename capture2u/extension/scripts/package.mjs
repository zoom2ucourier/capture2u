import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = path.join(root, "dist");
const outFile = path.resolve(root, "../public/capture2u-extension.zip");

const collect = async (dir, files = {}) => {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collect(fullPath, files);
			continue;
		}
		const zipPath = path.relative(distDir, fullPath).split(path.sep).join("/");
		files[zipPath] = new Uint8Array(await readFile(fullPath));
	}
	return files;
};

const files = await collect(distDir);
if (!files["manifest.json"]) {
	throw new Error("dist/manifest.json is missing. Run the build first.");
}

const sorted = Object.fromEntries(
	Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
);
// A fixed timestamp keeps the archive byte-identical between builds of the
// same source, so the committed zip only changes when the extension does.
const zipped = zipSync(sorted, { level: 9, mtime: new Date(2026, 0, 1) });
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, zipped);
const { size } = await stat(outFile);
console.log(
	`Wrote ${path.relative(root, outFile)} (${Object.keys(sorted).length} files, ${(size / 1024).toFixed(1)} KB)`,
);
