import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// Cap's own dependencies install an old Wrangler 3 at the top of the repo,
// which is what `npx wrangler` would pick up and which rejects this app's
// configuration. On the build server, point that command at the app's Wrangler.
const rootBin = join(repoRoot, "node_modules", ".bin");
if ((process.env.CI || process.env.WORKERS_CI) && existsSync(rootBin)) {
	const appWrangler = join(
		appDir,
		"node_modules",
		"wrangler",
		"bin",
		"wrangler.js",
	);
	for (const name of ["wrangler", "wrangler2"]) {
		const shim = join(rootBin, name);
		rmSync(shim, { force: true });
		writeFileSync(
			shim,
			`#!/bin/sh
exec node "${appWrangler}" "$@"
`,
			{
				mode: 0o755,
			},
		);
	}
	console.log("Deploys will use the Capture2u app's Wrangler.");
}

console.log("Capture2u built. Deploy with: npx wrangler deploy");
