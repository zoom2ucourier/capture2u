import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Library } from "./pages/Library";
import { RecordPage } from "./pages/Record";
import { Watch } from "./pages/Watch";
import "./styles.css";

function SignInScreen({ returnTo }: { returnTo?: string }) {
	const { signIn, error } = useAuth();
	return (
		<main className="center-screen">
			<div className="card sign-in">
				<h1>Capture2u</h1>
				<p className="muted">
					Record your screen and share a link. Sign in with your work Google
					account.
				</p>
				{error && <p className="alert">{error}</p>}
				<button
					type="button"
					className="button primary"
					onClick={() => void signIn(returnTo)}
				>
					Sign in with Google
				</button>
			</div>
		</main>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	const { user, signOut } = useAuth();
	return (
		<>
			<header className="topbar">
				<Link to="/" className="brand">
					Capture2u
				</Link>
				<nav>
					<Link to="/record" className="button primary small">
						New recording
					</Link>
					<span className="muted user-email">{user?.email}</span>
					<button
						type="button"
						className="button ghost small"
						onClick={() => void signOut()}
					>
						Sign out
					</button>
				</nav>
			</header>
			<main className="page">{children}</main>
		</>
	);
}

function Protected({ children }: { children: React.ReactNode }) {
	const { loading, user } = useAuth();
	if (loading) return <main className="center-screen muted">Loading…</main>;
	if (!user)
		return (
			<SignInScreen
				returnTo={window.location.pathname + window.location.search}
			/>
		);
	return <Shell>{children}</Shell>;
}

function App() {
	return (
		<Routes>
			<Route
				path="/"
				element={
					<Protected>
						<Library />
					</Protected>
				}
			/>
			<Route
				path="/record"
				element={
					<Protected>
						<RecordPage />
					</Protected>
				}
			/>
			<Route path="/v/:id" element={<Watch />} />
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<BrowserRouter>
				<AuthProvider>
					<App />
				</AuthProvider>
			</BrowserRouter>
		</StrictMode>,
	);
