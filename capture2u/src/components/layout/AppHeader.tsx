import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../common/Logo";

export function AppHeader({ children }: { children?: ReactNode }) {
	return (
		<header className="app-header">
			<Link to="/" className="app-header__brand" aria-label="Capture2u home">
				<Logo height={32} />
				<span className="app-header__divider" aria-hidden="true" />
				<span className="app-header__product">Capture2u</span>
			</Link>
			<nav className="app-header__actions">{children}</nav>
		</header>
	);
}
