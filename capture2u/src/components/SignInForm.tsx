import { useEffect, useState } from "react";
import { LOGIN_CODE_LENGTH } from "../../shared/types";
import { useAuth } from "../auth";
import { getConfig } from "../lib/api";
import { Button } from "./common/Button";
import { Alert } from "./common/Feedback";

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
				className="sign-in-form"
				onSubmit={(event) => {
					event.preventDefault();
					void send(false);
				}}
			>
				<p className="sign-in-form__intro">{intro}</p>
				{(error ?? accountError) && <Alert>{error ?? accountError}</Alert>}
				<label className="field">
					<span className="field__label">Work email</span>
					<input
						className="form-input"
						type="email"
						required
						autoComplete="email"
						inputMode="email"
						placeholder="you@locate2u.com"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</label>
				<Button
					type="submit"
					variant="primary"
					size="lg"
					fullWidth
					disabled={busy}
				>
					{busy ? "Sending…" : "Email me a code"}
				</Button>
				{domains.length > 0 && (
					<p className="field__hint">
						Works with {domains.map((domain) => `@${domain}`).join(", ")}{" "}
						addresses.
					</p>
				)}
			</form>
		);

	return (
		<form
			className="sign-in-form"
			onSubmit={(event) => {
				event.preventDefault();
				void verify();
			}}
		>
			<p className="sign-in-form__intro">
				Enter the {LOGIN_CODE_LENGTH}-digit code we sent to{" "}
				<strong>{address}</strong>.
			</p>
			{error && <Alert>{error}</Alert>}
			{notice && <p className="field__hint">{notice}</p>}
			<input
				className="form-input form-input--code"
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
			<Button
				type="submit"
				variant="primary"
				size="lg"
				fullWidth
				disabled={busy || code.length !== LOGIN_CODE_LENGTH}
			>
				{busy ? "Checking…" : "Sign in"}
			</Button>
			<div className="sign-in-form__links">
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => void send(true)}
				>
					Send a new code
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => {
						setStep("email");
						setError(null);
						setNotice(null);
					}}
				>
					Use another email
				</Button>
			</div>
		</form>
	);
}
