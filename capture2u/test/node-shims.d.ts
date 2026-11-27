declare module "node:fs/promises" {
	export function readFile(path: URL | string): Promise<Uint8Array>;
}

interface ImportMeta {
	readonly url: string;
}
