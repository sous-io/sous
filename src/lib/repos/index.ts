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

// Phase 2b: the store contract, the providers, the resolver, the trust layer
// and the lockfile service.
export * from "./providers/index.js";
export * from "./resolver.js";
export * from "./managed-layer.js";
export * from "./trust.js";
export * from "./lock-service.js";
export * from "./freshness.js";

// Phase 3: the consumer surface. Where a locked recipe's files are, the
// namespace resolver and compile targets built from that, and the service the
// `repo`, `subscribe` and `unsubscribe` commands drive.
export * from "./locked-recipes.js";
export * from "./locked-namespace-resolver.js";
export * from "./subscription-service.js";

// Phase 7: the core namespace. The recipe that ships inside the package, the
// seed that puts it in the store on first run, and the built-in repository and
// subscription every project gets unless it opts out.
export * from "./core-recipe.js";
