import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { Button, ButtonAnchor } from "../components/common/Button";
import { Card } from "../components/common/Card";
import { Alert, LoadingState } from "../components/common/Feedback";
import { Icons } from "../components/common/Icons";
import { GateCard } from "../components/layout/GateCard";
import { SignInForm } from "../components/SignInForm";
import { api } from "../lib/api";

const EXTENSION_REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org(\/[^#]*)?$/;

export const EXTENSION_DOWNLOAD_URL = "/capture2u-extension.zip";

export function ExtensionConnect() {
	const { loading, user } = useAuth();
	const [params] = useSearchParams();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const redirectUri = params.get("redirectUri") ?? "";
	const state = params.get("state") ?? "";

	if (!EXTENSION_REDIRECT.test(redirectUri))
		return (
			<GateCard title="Capture2u" icon={<Icons.AlertCircle />}>
				<p className="sign-in-form__intro">
					This page is opened by the Capture2u Chrome extension when you sign
					in. Open the extension and choose Sign in.
				</p>
			</GateCard>
		);

	if (loading) return <LoadingState fullScreen />;
	if (!user)
		return (
			<GateCard title="Capture2u">
				<SignInForm intro="Sign in with your work email to connect the Chrome extension." />
			</GateCard>
		);

	const finish = (fields: Record<string, string>) => {
		const fragment = new URLSearchParams(state ? { state, ...fields } : fields);
		window.location.assign(`${redirectUri}#${fragment.toString()}`);
	};

	const connect = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await api<{ redirectUrl: string }>(
				"/api/extension/auth/approve",
				{ body: { redirectUri, state } },
			);
			window.location.assign(result.redirectUrl);
		} catch {
			setError("Could not connect the extension. Please try again.");
			setBusy(false);
		}
	};

	return (
		<GateCard title="Connect the extension" icon={<Icons.Puzzle />}>
			<div className="sign-in-form">
				<p className="sign-in-form__intro">
					The Capture2u Chrome extension will record and upload videos as{" "}
					<strong>{user.email}</strong>.
				</p>
				{error && <Alert>{error}</Alert>}
				<Button
					variant="primary"
					size="lg"
					fullWidth
					disabled={busy}
					onClick={() => void connect()}
				>
					{busy ? "Connecting…" : "Connect"}
				</Button>
				<Button
					variant="ghost"
					fullWidth
					disabled={busy}
					onClick={() => finish({ error: "access_denied" })}
				>
					Cancel
				</Button>
			</div>
		</GateCard>
	);
}

const STEPS = [
	"Download the extension and unzip it into a folder you will keep.",
	'In Chrome, open chrome://extensions and switch on "Developer mode" in the top right corner.',
	'Click "Load unpacked" and choose the unzipped folder.',
	"Pin Capture2u to the toolbar, click it and sign in with your work email.",
];

export function ExtensionInstall() {
	return (
		<div className="extension-page">
			<div className="page-head">
				<div className="page-head__text">
					<h1 className="page-head__title">Chrome extension</h1>
					<p className="page-head__subtitle">
						Record from any page without keeping Capture2u open.
					</p>
				</div>
			</div>
			<Card title="What you get" icon={<Icons.Puzzle />}>
				<ul className="extension-page__list">
					<li>Start from the toolbar or with Alt+Shift+R on any page.</li>
					<li>Recording carries on when you close or change tabs.</li>
					<li>Draw on the page and show where you click.</li>
					<li>Blur private details on a page before they are recorded.</li>
					<li>The link is ready the moment you stop.</li>
				</ul>
			</Card>
			<Card title="Install it" icon={<Icons.Download />}>
				<ol className="extension-page__steps">
					{STEPS.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
				<div className="record__actions">
					<ButtonAnchor
						variant="primary"
						size="lg"
						startIcon={<Icons.Download />}
						href={EXTENSION_DOWNLOAD_URL}
						download
					>
						Download the extension
					</ButtonAnchor>
				</div>
				<p className="field__hint">
					Works in Chrome and Edge on a computer. Drawing, click highlights and
					blur work on web pages.
				</p>
			</Card>
		</div>
	);
}
