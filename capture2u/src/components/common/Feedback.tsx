import type { ReactNode } from "react";
import { Icons } from "./Icons";

export function Alert({ children }: { children: ReactNode }) {
	return (
		<p className="alert" role="alert">
			<Icons.AlertCircle className="alert__icon" />
			<span>{children}</span>
		</p>
	);
}

export function LoadingState({
	label = "Loading…",
	fullScreen = false,
}: {
	label?: string;
	fullScreen?: boolean;
}) {
	return (
		<output
			className={
				fullScreen ? "loading-state loading-state--screen" : "loading-state"
			}
		>
			<span className="loading-state__spinner" />
			<p className="loading-state__text">{label}</p>
		</output>
	);
}

export function EmptyState({
	icon,
	title,
	description,
	action,
}: {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="empty-state">
			{icon && <div className="empty-state__icon">{icon}</div>}
			<h2 className="empty-state__title">{title}</h2>
			{description && <p className="empty-state__description">{description}</p>}
			{action}
		</div>
	);
}

type BadgeTone = "neutral" | "started" | "failed" | "complete";

export function StatusBadge({
	tone = "neutral",
	children,
}: {
	tone?: BadgeTone;
	children: ReactNode;
}) {
	return (
		<span className={`status-badge status-badge--${tone}`}>{children}</span>
	);
}

const initialsOf = (name: string) => {
	const words = name
		.split("@")[0]
		?.split(/[\s._-]+/)
		.filter(Boolean);
	const first = words?.[0]?.[0] ?? "?";
	const second = words && words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
	return `${first}${second}`.toUpperCase();
};

export function Avatar({
	name,
	size = "md",
}: {
	name: string;
	size?: "sm" | "md";
}) {
	return (
		<span className={`avatar avatar--${size}`} aria-hidden="true">
			{initialsOf(name)}
		</span>
	);
}
