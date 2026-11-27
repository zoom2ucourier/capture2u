import type { SVGProps } from "react";
import { BRAND_LOGO_VIEW_BOX, BRAND_NAME } from "./brand-markup";

export const Capture2uBrand = (props: SVGProps<SVGSVGElement>) => (
	<svg
		className="brand-logo"
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox={BRAND_LOGO_VIEW_BOX}
		aria-label={BRAND_NAME}
		{...props}
	>
		<title>{BRAND_NAME}</title>
		<rect width="32" height="32" rx="8" fill="#2B93FF" />
		<circle cx="16" cy="16" r="9" fill="none" stroke="#fff" strokeWidth="2.5" />
		<circle cx="16" cy="16" r="4.5" fill="#fff" />
		<text
			x="42"
			y="22.6"
			fill="currentColor"
			fontFamily="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
			fontSize="19"
			fontWeight="600"
			textLength="92"
			lengthAdjust="spacingAndGlyphs"
		>
			{BRAND_NAME}
		</text>
	</svg>
);

export const DoodleBoilFilter = ({ id = "boil" }: { id?: string }) => (
	<filter id={id} x="-15%" y="-15%" width="130%" height="130%">
		<feTurbulence
			type="fractalNoise"
			baseFrequency="0.05"
			numOctaves="2"
			seed="1"
			result="noise"
		>
			<animate
				attributeName="seed"
				values="1;3;5;7"
				dur="0.6s"
				repeatCount="indefinite"
				calcMode="discrete"
			/>
		</feTurbulence>
		<feDisplacementMap
			in="SourceGraphic"
			in2="noise"
			scale="3"
			xChannelSelector="R"
			yChannelSelector="G"
		/>
	</filter>
);
