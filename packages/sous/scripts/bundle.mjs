// Bundles the published package (S3, "The bundler"): one ES module with core and every built-in
// plugin inside, and @sous-io/plugin-api outside, so plugins share sous's copy of it.
//
// Two files come out: `sous.js`, the bundle, and `bin.js`, the command, a few lines that turn on
// Node's compile cache and then import the bundle. The cache keeps the compiled bundle on disk
// between runs, which saves most of the time a start-up would spend compiling one large file; it
// only applies to modules loaded after it is turned on, so the bin must be a separate file.
//
//     node scripts/bundle.mjs                  # dist/bin.js and dist/sous.js
//     node scripts/bundle.mjs out/dir/bin.js   # out/dir/bin.js and out/dir/sous.js (the tests)
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as esbuild from "esbuild";

const packageDir = path.resolve(import.meta.dirname, "..");
const binFile = process.argv[2] === undefined ? path.join(packageDir, "dist/bin.js") : path.resolve(process.argv[2]);
const bundleFile = path.join(path.dirname(binFile), "sous.js");
const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

await esbuild.build({
    entryPoints: [path.join(packageDir, "src/bin.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: bundleFile,
    external: ["@sous-io/plugin-api"],
    conditions: ["source"],
    mainFields: ["module", "main"],
    splitting: false,
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    // CommonJS dependencies inside the bundle (yaml) call require() for Node's own modules, and
    // tiktoken finds its .wasm file through __dirname.
    banner: {
        js: 'import { createRequire as __sousCreateRequire } from "node:module";\nconst require = __sousCreateRequire(import.meta.url);\nconst __dirname = import.meta.dirname;',
    },
    define: { __SOUS_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
});

// tiktoken loads tiktoken_bg.wasm from next to the code that loads it: the bundle.
const compilerRequire = createRequire(path.resolve(packageDir, "../plugin-compiler/package.json"));

copyFileSync(path.join(path.dirname(compilerRequire.resolve("tiktoken")), "tiktoken_bg.wasm"), path.join(path.dirname(bundleFile), "tiktoken_bg.wasm"));

writeFileSync(
    binFile,
    [
        "#!/usr/bin/env node",
        'import { enableCompileCache } from "node:module";',
        "",
        "// Keeps the compiled bundle on disk between runs (Node 22.1 and later); start-up is faster.",
        "try {",
        "    enableCompileCache?.();",
        "} catch {",
        "    // No cache: sous still runs, only a little slower to start.",
        "}",
        "",
        'await import("./sous.js");',
        "",
    ].join("\n"),
    { mode: 0o755 },
);
