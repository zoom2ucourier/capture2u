import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Cloudflare builds this repository from its top folder. This builds only the
// Capture2u app and leaves a pointer so `wrangler deploy`, run from the top
// folder, deploys it.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const args of [["ci"], ["run", "build"]]) {
	const result = spawnSync(npm, args, {
		cwd: appDir,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const deployDir = join(repoRoot, ".wrangler", "deploy");
mkdirSync(deployDir, { recursive: true });
writeFileSync(
	join(deployDir, "config.json"),
	JSON.stringify({
		configPath: relative(
			deployDir,
			join(appDir, "dist", "capture2u", "wrangler.json"),
		).replaceAll("\\", "/"),
		auxiliaryWorkers: [],
	}),
);
console.log("Capture2u built. Deploy with: npx wrangler deploy");
