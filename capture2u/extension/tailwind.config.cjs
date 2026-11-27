const colorScale = (name, alpha = false) => {
	const scale = {};
	for (let step = 1; step <= 12; step += 1) {
		scale[step] = `var(--${name}-${step})`;
		if (alpha) scale[`a${step}`] = `var(--${name}-a${step})`;
	}
	return scale;
};

module.exports = {
	content: [
		"./popup.html",
		"./popup-window.html",
		"./options.html",
		"./recorder.html",
		"./camera-preview.html",
		"./camera-permission.html",
		"./src/**/*.{ts,tsx}",
	],
	theme: {
		screens: {
			xs: "480px",
			sm: "640px",
			md: "768px",
			lg: "1024px",
			xl: "1280px",
			"2xl": "1536px",
		},
		fontWeight: {
			thin: "300",
			hairline: "300",
			extralight: "300",
			light: "300",
			normal: "400",
			medium: "500",
			semibold: "500",
			bold: "600",
			extrabold: "600",
			"extra-bold": "600",
		},
		extend: {
			colors: {
				gray: colorScale("gray"),
				"gray-a": colorScale("gray-a", true),
				blue: colorScale("blue"),
				border: "hsl(var(--border))",
				input: "hsl(var(--input))",
				ring: "hsl(var(--ring))",
				background: "hsl(var(--background))",
				foreground: "hsl(var(--foreground))",
				primary: {
					DEFAULT: "var(--primary)",
					foreground: "hsl(var(--primary-foreground))",
				},
				secondary: {
					DEFAULT: "var(--secondary)",
					foreground: "var(--secondary-foreground)",
				},
				destructive: {
					DEFAULT: "hsl(var(--destructive))",
					foreground: "hsl(var(--destructive-foreground))",
				},
				muted: {
					DEFAULT: "hsl(var(--muted))",
					foreground: "hsl(var(--muted-foreground))",
				},
				accent: {
					DEFAULT: "hsl(var(--accent))",
					foreground: "hsl(var(--accent-foreground))",
				},
				popover: {
					DEFAULT: "hsl(var(--popover))",
					foreground: "hsl(var(--popover-foreground))",
				},
				card: {
					DEFAULT: "hsl(var(--card))",
					foreground: "hsl(var(--card-foreground))",
				},
				red: {
					...colorScale("red"),
					50: "#FFEBEE",
					100: "#FFADBB",
					200: "#FF8599",
					300: "#FF4766",
					400: "#E03F5A",
				},
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};
