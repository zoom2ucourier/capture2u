import type { ReactNode } from "react";

export function Card({
	title,
	icon,
	actions,
	className,
	children,
}: {
	title?: string;
	icon?: ReactNode;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section className={className ? `card ${className}` : "card"}>
			{title && (
				<header className="card__header">
					<h2 className="card__title">
						{icon}
						{title}
					</h2>
					{actions}
				</header>
			)}
			<div className="card__body">{children}</div>
		</section>
	);
}
