import blueMd from "../../assets/l2u-logo-blue-md.png";
import blueSm from "../../assets/l2u-logo-blue-sm.png";
import classicMd from "../../assets/l2u-logo-classic-md.png";
import classicSm from "../../assets/l2u-logo-classic-sm.png";

const SOURCES = {
	classic: { sm: classicSm, md: classicMd },
	blue: { sm: blueSm, md: blueMd },
};

const ASPECT_RATIO = 1359 / 351;

export function Logo({
	variant = "classic",
	height = 32,
}: {
	variant?: "classic" | "blue";
	height?: number;
}) {
	const source = SOURCES[variant];
	return (
		<img
			className="logo"
			src={source.sm}
			srcSet={`${source.sm} 200w, ${source.md} 400w`}
			sizes={`${Math.round(height * ASPECT_RATIO)}px`}
			alt="Locate2u"
			height={height}
			width={Math.round(height * ASPECT_RATIO)}
		/>
	);
}
