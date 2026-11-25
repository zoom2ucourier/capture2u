import { useEffect, useState } from "react";
import { LOGIN_CODE_LENGTH } from "../../shared/types";
import { useAuth } from "../auth";
import { getConfig } from "../lib/api";

const messageOf = (cause: unknown, fallback: string) =>
	cause instanceof Error && cause.message && cause.message !== "request_failed"
		? cause.message
		: fallback;

export function SignInForm({ intro }: { intro: string }) {
	const { requestCode, verifyCode, error: accountError } = useAuth();
	const [step, setStep] = useState<"email" | "code">("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [domains, setDomains] = useState<string[]>([]);

	useEffect(() => {
		let cancelled = false;
		getConfig()
			.then((config) => {
				if (!cancelled) setDomains(config.allowedDomains);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const address = email.trim().toLowerCase();

	const send = async (resend: boolean) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await requestCode(address);
			setStep("code");
			setCode("");
			if (resend) setNotice("A new code is on its way.");
		} catch (cause) {
			setError(messageOf(cause, "Could not send the code. Try again."));
		} finally {
			setBusy(false);
		}
	};

	const verify = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await verifyCode(address, code);
		} catch (cause) {
			setError(messageOf(cause, "That code is not right."));
		} finally {
			setBusy(false);
		}
	};

	if (step === "email")
		return (
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void send(false);
				}}
			>
				<p className="muted">{intro}</p>
				{(error ?? accountError) && (
					<p className="alert">{error ?? accountError}</p>
				)}
				<input
					type="email"
					required
					autoComplete="email"
					inputMode="email"
					placeholder="you@locate2u.com"
					aria-label="Work email address"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
				/>
				<button
					type="submit"
					className="button primary"
					disabled={busy || !address}
				>
					{busy ? "Sending…" : "Email me a code"}
				</button>
				{domains.length > 0 && (
					<p className="muted small-text">
						Works with {domains.map((domain) => `@${domain}`).join(", ")}{" "}
						addresses.
					</p>
				)}
			</form>
		);

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void verify();
			}}
		>
			<p className="muted">
				Enter the {LOGIN_CODE_LENGTH}-digit code we sent to{" "}
				<strong>{address}</strong>.
			</p>
			{error && <p className="alert">{error}</p>}
			{notice && <p className="muted small-text">{notice}</p>}
			<input
				className="code-input"
				type="text"
				required
				inputMode="numeric"
				autoComplete="one-time-code"
				pattern={`[0-9]{${LOGIN_CODE_LENGTH}}`}
				maxLength={LOGIN_CODE_LENGTH}
				placeholder={"0".repeat(LOGIN_CODE_LENGTH)}
				aria-label="Sign-in code"
				value={code}
				onChange={(event) =>
					setCode(
						event.target.value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH),
					)
				}
			/>
			<button
				type="submit"
				className="button primary"
				disabled={busy || code.length !== LOGIN_CODE_LENGTH}
			>
				{busy ? "Checking…" : "Sign in"}
			</button>
			<div className="row centered">
				<button
					type="button"
					className="button ghost small"
					disabled={busy}
					onClick={() => void send(true)}
				>
					Send a new code
				</button>
				<button
					type="button"
					className="button ghost small"
					disabled={busy}
					onClick={() => {
						setStep("email");
						setError(null);
						setNotice(null);
					}}
				>
					Use another email
				</button>
			</div>
		</form>
	);
}
