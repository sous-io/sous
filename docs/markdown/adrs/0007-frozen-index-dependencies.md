# ADR 0007: A published version's index entry is frozen, and readers keep what they do not know

**Status:** Accepted, 2026-09-29.

This record amends [ADR 0001](0001-repositories.md) in two places: what a release may change in
`sous.index.json`, and how strictly sous reads that file. Everything else it says about the index still
holds. The living answer is [`sous.index.json`](../repositories-file-formats.md#sousindexjson); the process
records are [gh-122](https://github.com/sous-io/sous/issues/122) and
[gh-124](https://github.com/sous-io/sous/issues/124).

## Context

Each version the index publishes records the exact versions of its dependencies, so that a consumer
installs what the version was released against. The schema says what that is for:

> "A consumer installing this version installs these versions rather than re-resolving the ranges its
> manifest declared, so a published version means one thing forever."
>
>   -- `indexVersionSchema`, doc comment on `dependencies` (`src/lib/repos/formats/index-file.ts`)

`buildIndex` did not keep that promise. It resolved the current manifest version's dependencies on every
run and wrote the result over the published entry, while the hash beside it was already frozen. A preset
set that subscribes to a whole namespace gained every recipe added to that namespace later, and a sibling
it named moved to each new version the sibling released, all under one unchanged version and hash. The
reproduction is in gh-122. The user chose to freeze the list:

> "1"
>
>   -- **the user** in an agent session (2026-09-29), recorded in gh-122 as option 1, "Freeze each
>   published version's dependencies, as the hash already is, and make a disagreement an error."

Separately, gh-124 plans new per-version fields (how each dependency was declared, whether it is a
co-subscription, and the version's variable definitions), so `sous recipe show` and
`sous subscription add --dry-run` can describe a recipe from the index alone. Every index schema was a
`z.strictObject`, so any sous predating a new field would refuse the whole index. The user chose to ship
tolerant readers first and the fields in a later release:

> "Option 2"
>
>   -- **the user** in an agent session (2026-09-29), recorded in gh-124 as "first release readers that
>   ignore unknown index fields, then add the fields to the index itself in a later release, accepting
>   that projects pinned to an older sous break reading the official index."

## Decision

- **A tagged version's entry is carried forward as published.** Once the index records a version and its
  tag exists, a release never rewrites the entry: not its hash, not its dependencies, not any other field.
  The one exception is a missing `releasedAt`, filled in from the tag, as before.
- **Dependencies are resolved exactly once.** A version being recorded for the first time resolves against
  the repository as it stands, counting what the run itself publishes. A version whose tag carries it but
  the index lost is rebuilt from the tree at that tag, and its dependencies are resolved against the
  repository as it stood there: a sibling with no range is the version its manifest declared at the tag,
  and a range resolves only among versions up to that one. Either way the result is then frozen.
- **The check compares the frozen list with the manifest, never with a fresh resolution.** A fresh
  resolution legitimately differs as soon as a sibling releases or a namespace gains a recipe, so comparing
  with it would fail every later release of an unrelated recipe. What a release checks, for the version
  the manifest declares while its folder still matches the tag, is that the recorded list honours the
  manifest: every recipe the manifest names is present, nothing is present that the manifest does not
  declare (a recipe a declared namespace held when the version was published, and has since retired, is
  history and passes), a sibling sits inside its declared range, and a dependency in another repository
  carries the repository and range the manifest wrote. A disagreement is an error in both
  `sous repo release` and `sous repo release --check`, naming the recipe, the version and each difference,
  and telling the author to restore the entry or bump the version.
- **An entry with no dependencies at all is left alone.** It was written before sous recorded
  dependencies; a consumer resolves that version's ranges, and it stays that way rather than being filled
  in after the fact.
- **Every index reader keeps fields it does not know.** Each object in the index schema is a
  `forwardCompatibleObject` (`src/lib/repos/formats/common.ts`): every field this sous defines is
  validated in full, and any other field is kept, unread, instead of refused. Keeping rather than dropping
  them matters to the first decision: a release run by this sous, after a newer one has written fields
  into a published entry, carries that entry forward with the fields intact instead of stripping them. Only the index changes; every other
  machine-written format stays strict, because nothing plans to add fields to them.
- **The new fields come in a second release.** This release ships only the tolerant readers. The fields
  gh-124 describes ship in a later release, after this one is published, and are frozen with the rest of
  the entry.

## Consequences

- The gh-122 reproduction leaves `omakase/house@0.1.0`'s entry byte for byte unchanged across later
  releases. A recipe that wants newer dependencies publishes a new version, which resolves them afresh.
- An index that was already rewritten by the old behavior keeps whatever its current entries say; nothing
  repairs them, and each is frozen as it stands from the next release on.
- A hand edit to a published version's dependencies is caught by the next release or pull request check,
  and so is a later sous that reads a manifest differently from the one that published it.
- Once the second release publishes its fields into a repository's index, a project pinned to a sous
  older than this release fails to read that index. The user accepted this in choosing option 2.
- An older sous that regenerates an index drops unknown top-level, namespace and recipe fields, because it
  rebuilds those objects from the manifests; only published version entries are carried forward whole.
- `src/lib/repos/release/index-builder.spec.ts` holds the reproduction, the tag rebuild, the disagreement
  errors and the carried-forward unknown fields; `src/lib/repos/formats/index-file.spec.ts` holds the
  tolerant reader; `src/test/integration/repo-release.test.ts` holds the `--check` failure.
