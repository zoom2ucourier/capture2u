import { fileURLToPath } from "node:url";

const recorderCore = fileURLToPath(
	new URL("../../packages/recorder-core/src", import.meta.url),
);

export const recorderCoreAlias = [
	{ find: /^@cap\/recorder-core/, replacement: recorderCore },
];
