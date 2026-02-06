import { defineConfig } from "tsup";

export const config = defineConfig({
	bundle: false,
	dts: false,
	entry: [
		"src/**/*.{ts,tsx}",
		"!src/**/*.{spec,test}.{ts,tsx}",
		"src/**/*.{jpg,png,svg}",
	],
	format: ["esm", "cjs"],
	legacyOutput: true,
	loader: {
		".jpg": "copy",
		".png": "copy",
		".svg": "copy",
	},
	outDir: "dist",
	sourcemap: true,
	target: "esnext",
});
