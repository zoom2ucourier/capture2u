import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { recorderCoreAlias } from "./vite.shared";

export default defineConfig({
	plugins: [react()],
	resolve: { alias: recorderCoreAlias },
	build: {
		emptyOutDir: false,
		outDir: "dist",
		rollupOptions: {
			input: {
				popup: resolve(__dirname, "popup.html"),
				"popup-window": resolve(__dirname, "popup-window.html"),
				options: resolve(__dirname, "options.html"),
				recorder: resolve(__dirname, "recorder.html"),
				uploading: resolve(__dirname, "uploading.html"),
				offscreen: resolve(__dirname, "offscreen.html"),
				"camera-preview": resolve(__dirname, "camera-preview.html"),
				"camera-permission": resolve(__dirname, "camera-permission.html"),
				"service-worker": resolve(
					__dirname,
					"src/background/service-worker.ts",
				),
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
