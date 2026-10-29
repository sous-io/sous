// Bundles the published package (S3, "The bundler"): one ES module with core and every built-in
// plugin inside, and @sous-io/plugin-api outside, so plugins share sous's copy of it.
import { readFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const packageDir = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

await esbuild.build({
    entryPoints: [path.join(packageDir, "src/bin.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: path.join(packageDir, "dist/bin.js"),
    external: ["@sous-io/plugin-api"],
    conditions: ["source"],
    mainFields: ["module", "main"],
    splitting: false,
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    banner: { js: "#!/usr/bin/env node" },
    define: { __SOUS_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
});
