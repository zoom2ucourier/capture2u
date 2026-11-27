import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const recorderCore = fileURLToPath(
	new URL("../packages/recorder-core/src", import.meta.url),
);

export default defineConfig({
	plugins: [react(), cloudflare()],
	optimizeDeps: { entries: ["index.html"] },
	resolve: {
		alias: [{ find: /^@cap\/recorder-core/, replacement: recorderCore }],
	},
});
