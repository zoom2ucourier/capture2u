import type {
	AnchorHTMLAttributes,
	ButtonHTMLAttributes,
	ReactNode,
} from "react";
import { Link, type LinkProps } from "react-router-dom";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonStyleProps {
	variant?: Variant;
	size?: Size;
	fullWidth?: boolean;
	iconOnly?: boolean;
	active?: boolean;
	startIcon?: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
	primary: "btn--primary",
	secondary: "btn--secondary",
	ghost: "btn--ghost",
	danger: "btn--ghost btn--danger",
};

const buttonClass = (
	{
		variant = "secondary",
		size = "md",
		fullWidth,
		iconOnly,
		active,
	}: ButtonStyleProps,
	className?: string,
) =>
	[
		"btn",
		VARIANT_CLASS[variant],
		`btn--${size}`,
		fullWidth && "btn--full-width",
		iconOnly && "btn--icon-only",
		active && "btn--active",
		className,
	]
		.filter(Boolean)
		.join(" ");

const content = (startIcon: ReactNode, children: ReactNode) => (
	<>
		{startIcon && <span className="btn__icon">{startIcon}</span>}
		{children}
	</>
);

export function Button({
	variant,
	size,
	fullWidth,
	iconOnly,
	active,
	startIcon,
	className,
	children,
	type = "button",
	...rest
}: ButtonStyleProps & ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type={type}
			className={buttonClass(
				{ variant, size, fullWidth, iconOnly, active },
				className,
			)}
			{...rest}
		>
			{content(startIcon, children)}
		</button>
	);
}

export function ButtonLink({
	variant,
	size,
	fullWidth,
	iconOnly,
	active,
	startIcon,
	className,
	children,
	...rest
}: ButtonStyleProps & LinkProps) {
	return (
		<Link
			className={buttonClass(
				{ variant, size, fullWidth, iconOnly, active },
				className,
			)}
			{...rest}
		>
			{content(startIcon, children)}
		</Link>
	);
}

export function ButtonAnchor({
	variant,
	size,
	fullWidth,
	iconOnly,
	active,
	startIcon,
	className,
	children,
	...rest
}: ButtonStyleProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
	return (
		<a
			className={buttonClass(
				{ variant, size, fullWidth, iconOnly, active },
				className,
			)}
			{...rest}
		>
			{content(startIcon, children)}
		</a>
	);
}
