/**
 * The ref resolver service: how every sous command and template turns a
 * written ref into the thing it names.
 *
 * Import from here. `types.ts` says what a ref is, the parser reads every way a
 * text can be one, a pruner per place says which readings count there, a
 * lookup says which exist, `RefResolverService` runs the three in order, and
 * `RefPickerService` settles which meaning a run proceeds with.
 */

export * from "./source.js";
export * from "./types.js";
export * from "./parts.js";
export * from "./glob.js";
export * from "./location.js";
export * from "./format.js";
export * from "./tokens.js";
export * from "./injectable.js";
export * from "./parser/partial-ref.js";
export * from "./parser/ref-parser.js";
export * from "./parser/query-splitter.js";
export * from "./parser/range-splitter.js";
export * from "./parser/location-splitter.js";
export * from "./parser/repo-qualifier-splitter.js";
export * from "./parser/name-path-splitter.js";
export * from "./parser/env-var-splitter.js";
export * from "./pruners/ref-pruner.js";
export * from "./pruners/rule-helpers.js";
export * from "./pruners/command-line-pruner.js";
export * from "./pruners/stored-key-pruner.js";
export * from "./pruners/manifest-pruner.js";
export * from "./pruners/include-pruner.js";
export * from "./lookups/ref-lookup.js";
export * from "./lookups/chained-lookup.js";
export * from "./lookups/catalog-matcher.js";
export * from "./lookups/cached-index-lookup.js";
export * from "./lookups/recorded-dependency-lookup.js";
export * from "./lookups/fetched-index-lookup.js";
export * from "./lookups/variable-lookup.js";
export * from "./lookups/env-var-lookup.js";
export * from "./ref-resolve-arguments.js";
export * from "./ref-resolve-result.js";
export * from "./ref-resolver-service.js";
export * from "./ref-picker-service.js";
export * from "./ref-helpers.js";
export * from "./container.js";
