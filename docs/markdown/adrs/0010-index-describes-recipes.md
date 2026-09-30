# ADR 0010: The index describes each version's dependencies and questions

**Status:** Proposed, 2026-09-29.

This record builds on [ADR 0007](0007-frozen-index-dependencies.md), which shipped the readers that tolerate
unknown index fields and promised the fields themselves in a later release. This is that release. The living
answer is [`sous.index.json`](../repositories-file-formats.md#sousindexjson); the process record is
[gh-124](https://github.com/sous-io/sous/issues/124).

## Context

A preset set such as `omakase/house` is a recipe with no files of its own that only `subscribes` to other
recipes and namespaces. Before subscribing, a person wants to know what the set installs and what it will
ask. The index could answer neither: per dependency it recorded only a version or a range and a repository,
and per version nothing about questions. So `sous recipe show` printed "not declared in the manifest" and the
kind "unknown" for every member of a set not in the store, and `sous subscription add --dry-run` printed
"Not on this machine yet, so their questions cannot be listed" for every recipe it had not installed.

The user chose what the index records:

> "1"
>
>   -- **the user** in an agent session (2026-09-29), recorded in gh-124 as option 1: "record in the index,
>   per dependency, how it was declared and whether it is a co-subscription or a build dependency, and per
>   version its variable definitions, so `recipe show` and `subscription add --dry-run` work offline."

and how it rolls out:

> "Option 2"
>
>   -- **the user** in an agent session (2026-09-29), recorded in gh-124 as "first release readers that
>   ignore unknown index fields, then add the fields to the index itself in a later release, accepting
>   that projects pinned to an older sous break reading the official index."

The first release is sous 0.2.26 (ADR 0007).

## Decision

The two quoted rulings are the user's. Every detail below them is an agent suggestion the user has not ruled
on, proposed for review in the pull request that closes gh-124.

- **Each dependency records how it was declared.** `declared` is the manifest entry that brings it in,
  exactly as written: a recipe (`tools/gamma@^0.1`), a whole namespace of the same repository (`workflow`),
  or a locator. `kind` is `subscribes` (a co-subscription) or `depends` (a build dependency), the names of
  the manifest lists themselves, and the same values the lockfile's `kind` already uses. When several
  entries cover one recipe, the entry naming it wins over a namespace, and it is a co-subscription when any
  entry covering it is one: the rule the resolver already applies when it settles a recipe's kind.
- **Each version records its variable definitions.** `variables` is the manifest's `variables` list, parsed
  by the manifest's own rules, with `required`, `secret` and `scope` filled in. The index schema reads it
  with the same field definitions and the same checks as the manifest (`variableDefinitionShape` and
  `checkVariableDefinition` in `src/lib/repos/formats/variable-definition.ts`); the one difference is that it
  keeps a field it does not know, as every index object does. The index records definitions only, never an
  answer, so it adds no answer source outside the ladder.
- **Each version records its manifest's lists.** `depends` and `subscribes` are the manifest's lists,
  exactly as written, and they are what a consumer walks when it has not fetched the recipe. The
  per-dependency `declared` cannot stand in for them: a whole namespace of another repository is read from
  that repository's own index, so no recipe key of `dependencies` records it. The lists are kept as plain
  strings, so a ref form a later sous accepts never breaks this reader.
- **"None" and "not recorded" read differently.** A described version always carries every field:
  `"dependencies": {}` for a version with no dependencies, `[]` for an empty list, and `"variables": []`
  for one that asks nothing. An absent field, or a dependency without `declared` and `kind`, means the
  release that recorded the version predates this record.
- **Only newly recorded versions get the fields.** A published version's entry is frozen (ADR 0007), so no
  release fills them in afterwards. A version being published, and a version rebuilt from its tag because
  the index lost it, are described from the manifest they carry. The release's check of a published entry
  against its manifest now also compares `declared`, `kind`, `depends` and `subscribes` when the entry
  records them.
- **One rule, in one module.** `foldDeclaration` in `src/lib/repos/declarations.ts` decides a recipe's
  declaration, entry by entry, for the release that records it and, through `declarationFor`, for
  `sous recipe show` reading an older entry beside its manifest; `indexDependencyLists` reads a version's
  recorded lists.
- **Readers use the fields when present and fall back when absent.** The resolver walks a recipe whose
  manifest it cannot load from its index entry's lists, exactly as it would walk the manifest, so a
  namespace entry still expands to the namespace as it stands; only a recipe whose entry records nothing is
  reported as unreadable. The dry run's question plan takes a recipe's questions from its manifest when its
  files are here and from its index entry otherwise. `sous recipe show` resolves the closure the same way,
  through `SubscriptionService.previewSubscription`, and prints the questions with the dry run's own
  renderer, without the flags that answer them ahead of time.

## Consequences

- `sous recipe show omakase/house` lists every member, the entry that brought each in and its kind, every
  recipe a subscription installs, and every question it asks, with nothing in the store.
  `sous subscription add omakase/house --dry-run` lists the same questions. `sous lock rebuild` walks a
  recipe that is not in the store from its index entry too.
- A project pinned to a sous older than 0.2.26 fails to read the index of any repository released with these
  fields, the official one included. The user accepted this in choosing option 2.
- A version published before this release keeps its entry as it is. Its questions are listed once its
  files are fetched, and a dry run names it as unknown until then.
- A later sous that adds a field to a variable definition is read by this one, which keeps the field unread.
  A later sous that adds a new variable `type` is not: this one refuses the value, as it would in a manifest.
- `src/lib/repos/release/index-builder.spec.ts`, `src/lib/repos/declarations.spec.ts`,
  `src/lib/repos/resolver.spec.ts` and `src/lib/repos/formats/index-file.spec.ts` hold the unit tests;
  `src/test/integration/recipe-sets.test.ts` releases a set with the real CLI and describes it before
  subscribing.
