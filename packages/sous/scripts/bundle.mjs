// Bundles the published package (S3, "The bundler"): one ES module with core and every built-in
// plugin inside, and @sous-io/plugin-api outside, so plugins share sous's copy of it.
import { readFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const packageDir = path.resolve(import.meta.dirname, "..");
// The output file: dist/bin.js, or the path given as the first argument (the tests bundle into a
// directory of their own, so two test runs never overwrite each other's bin).
const outfile = process.argv[2] === undefined ? path.join(packageDir, "dist/bin.js") : path.resolve(process.argv[2]);
const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

await esbuild.build({
    entryPoints: [path.join(packageDir, "src/bin.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile,
    external: ["@sous-io/plugin-api"],
    conditions: ["source"],
    mainFields: ["module", "main"],
    splitting: false,
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    // CommonJS dependencies inside the bundle (yaml) call require() for Node's own modules.
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as __sousCreateRequire } from "node:module";\nconst require = __sousCreateRequire(import.meta.url);' },
    define: { __SOUS_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
});
