// Puts the files the published package carries besides its bundle into this package while it is
// packed, and takes them out again afterwards. They live at the repository root, where the docs
// site and the recipe tooling use them:
//   - recipes/: the packaged core recipe, which seeds a machine's store (an offline first build);
//   - docs/markdown/*.md: the docs the core skills point agents at (`${sousRootPath}/docs/markdown`);
//   - sous.config.schema.json: the JSON schema a sous.config.json binds to.
//
//     node scripts/pack-files.mjs copy    # prepack
//     node scripts/pack-files.mjs clean   # postpack
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const copied = ["recipes", "docs", "sous.config.schema.json"];

for (const name of copied) {
    rmSync(path.join(packageDir, name), { recursive: true, force: true });
}

if (process.argv[2] === "copy") {
    cpSync(path.join(repoRoot, "recipes"), path.join(packageDir, "recipes"), { recursive: true });
    cpSync(path.join(repoRoot, "sous.config.schema.json"), path.join(packageDir, "sous.config.schema.json"));

    const docs = path.join(packageDir, "docs", "markdown");

    mkdirSync(docs, { recursive: true });

    for (const file of readdirSync(path.join(repoRoot, "docs", "markdown"))) {
        if (file.endsWith(".md")) {
            cpSync(path.join(repoRoot, "docs", "markdown", file), path.join(docs, file));
        }
    }
}
