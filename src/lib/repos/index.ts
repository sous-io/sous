/**
 * The Repositories layer: every on-disk format, the loaders that read them, and
 * the ref parser that names what is inside them.
 *
 * Import from here rather than from the individual modules, so later phases
 * (the store, the providers, the resolver, the CLI surface) have one place to
 * look for what this layer offers.
 */

// The regular expressions in formats/patterns.js reach here through
// formats/common.js, which re-exports them; listing patterns.js again would
// make every one of those names an ambiguous star export.
export * from "./formats/common.js";
export * from "./formats/repo-manifest.js";
export * from "./formats/recipe-manifest.js";
export * from "./formats/index-file.js";
export * from "./formats/lockfile.js";
export * from "./formats/store-entry.js";
export * from "./formats/links-map.js";
export * from "./load-manifest.js";
export * from "./ref.js";

// Phase 2a: the machine-wide recipe store, under the user-level sous directory.
export * from "./store/contract.js";
export * from "./store/hash.js";
export * from "./store/recipe-store.js";
export * from "./store/settings.js";

// Phase 6a: the CLI surface for editable checkouts (`sous repo init`, `link`,
// `unlink`). The links map and its ignore hygiene, the thin git layer both of
// them use, and the scaffold that `repo init` writes.
export * from "./links.js";
export * from "./git-clone.js";
export * from "./scaffold/index.js";
