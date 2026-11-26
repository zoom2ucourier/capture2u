import type { ReactNode } from "react";
import { Logo } from "../common/Logo";

export function GateCard({
	title,
	icon,
	children,
}: {
	title: string;
	icon?: ReactNode;
	children: ReactNode;
}) {
	return (
		<main className="gate">
			<div className="gate__card">
				<div className="gate__logo">
					<Logo height={40} />
				</div>
				{icon && <div className="gate__icon">{icon}</div>}
				<h1 className="gate__title">{title}</h1>
				<div className="gate__body">{children}</div>
			</div>
		</main>
	);
}
