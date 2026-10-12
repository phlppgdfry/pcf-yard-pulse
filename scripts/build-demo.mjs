// Bundles the demo (real control + mock host + simulator) into site/.
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
    entryPoints: ["demo/main.ts"],
    outfile: "site/demo.js",
    bundle: true,
    minify: true,
    sourcemap: true,
    target: "es2020",
    format: "iife",
    logLevel: "info",
});
await copyFile("YardPulse/css/YardPulse.css", "site/YardPulse.css");
