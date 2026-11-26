import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Button, ButtonLink } from "./components/common/Button";
import { Avatar, LoadingState } from "./components/common/Feedback";
import { Icons } from "./components/common/Icons";
import { AppHeader } from "./components/layout/AppHeader";
import { GateCard } from "./components/layout/GateCard";
import { SignInForm } from "./components/SignInForm";
import { Embed } from "./pages/Embed";
import { Library } from "./pages/Library";
import { RecordPage } from "./pages/Record";
import { Watch } from "./pages/Watch";
import "@fontsource-variable/inter";
import "./styles/index.css";

function SignInScreen() {
	return (
		<GateCard title="Capture2u">
			<SignInForm intro="Record your screen and share a link. Sign in with your work email." />
		</GateCard>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	const { user, signOut } = useAuth();
	return (
		<div className="app">
			<AppHeader>
				<ButtonLink to="/record" variant="primary" startIcon={<Icons.Record />}>
					New recording
				</ButtonLink>
				{user && (
					<span className="app-header__user">
						<Avatar name={user.fullName ?? user.email} />
						<span className="app-header__email">{user.email}</span>
					</span>
				)}
				<Button
					variant="ghost"
					aria-label="Sign out"
					startIcon={<Icons.LogOut />}
					onClick={() => void signOut()}
				>
					<span className="app-header__sign-out">Sign out</span>
				</Button>
			</AppHeader>
			<main className="page">{children}</main>
		</div>
	);
}

function Protected({ children }: { children: React.ReactNode }) {
	const { loading, user } = useAuth();
	if (loading) return <LoadingState fullScreen />;
	if (!user) return <SignInScreen />;
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
			<Route path="/embed/:id" element={<Embed />} />
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
