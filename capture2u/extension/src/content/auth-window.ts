import { useEffect, useState } from "react";
import { sendServiceWorkerMessage } from "../shared/runtime";
import { loadPendingAuth, PENDING_AUTH_KEY } from "../shared/storage";

// True when this page is the chrome.identity sign-in window of a sign-in in
// progress, false when it is not, and null until that is known. Only a
// pending sign-in costs a service-worker round trip; every other page load
// settles on one storage read.
export const useIsAuthWindow = () => {
	const [authWindow, setAuthWindow] = useState<boolean | null>(null);

	useEffect(() => {
		let disposed = false;

		const check = () => {
			loadPendingAuth()
				.then(async (pending) => {
					if (!pending) return false;
					const response = await sendServiceWorkerMessage({
						target: "service-worker",
						type: "is-auth-window",
					});
					return response.ok && response.authWindow === true;
				})
				.catch(() => false)
				.then((value) => {
					if (!disposed) setAuthWindow(value);
				});
		};

		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName === "local" && changes[PENDING_AUTH_KEY]) check();
		};

		check();
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			disposed = true;
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);

	return authWindow;
};
