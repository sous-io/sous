/**
 * The Inversify tokens of the ref services, in one place. A plugin adds a
 * splitter, a pruner or a provider by binding one more value under the matching
 * token; nothing else in the module needs to change.
 */

/** Every token the ref services are bound under. */
export const REF_TOKENS = {
  /** A `RefSplitter`; bound once per splitter, injected as a list. */
  Splitter: Symbol.for("sous.ref.Splitter"),
  /** A `RefPruner`; bound once per pruner, injected as a list. */
  Pruner: Symbol.for("sous.ref.Pruner"),
  /** A `RepoProvider`; bound once per provider, injected as a list. */
  Provider: Symbol.for("sous.ref.Provider"),
  /** A `HashName`; bound once per `#` name, injected as a list. */
  HashName: Symbol.for("sous.ref.HashName"),
  /** The `HashNameRegistry`. */
  HashNames: Symbol.for("sous.ref.HashNames"),
  /** The `RefParser`. */
  Parser: Symbol.for("sous.ref.Parser"),
  /** The `RefResolverService`. */
  Resolver: Symbol.for("sous.ref.Resolver"),
  /** The `RefPickerService`. */
  Picker: Symbol.for("sous.ref.Picker"),
} as const;
