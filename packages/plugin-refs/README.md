# @sous-io/plugin-refs

Parsing and resolving refs, picking among matches, # names, repository locations and identity.

- **Specified in:** S6, "Shared building blocks (refs.*, hash-name)".
- **Capabilities (S7):** C46 (--accept-first answers the pick).
- **Depends on:** `plugin-host` (`host.globs` decides what is glob syntax).
- **Contract:** `src/types.ts` declares every service, intent, event, entity kind and config key this
  plugin owns. Other plugins import it type-only: `import type {} from "@sous-io/plugin-refs/types";`.

## What it registers

- Services, each `config` (they read entities): `refs.parser`, `refs.resolver`, `refs.picker`,
  `refs.format`, `refs.locations`.
- Entity kinds: `ref-splitter`, `ref-pruner`, `ref-lookup`, `hash-name`.
- Entities: the splitters `query` (10), `range` (20), `location` (30), `repo-qualifier` (40),
  `env-var` (50) and `name-path` (60); a pruner for each of `commandLine`, `config`, `manifest`,
  `lockfile` and `include`; the `#project` name.

Hosts are the `repository-host` entities plugin-recipes defines and the host plugins add. Reading them
needs no dependency: with no host loaded, short refs work and every location is refused with a reason.

## Lookups

`refs.resolver.resolve()` asks `ref-lookup` entities. `lookups: true` (the default) asks every lookup
that is not `optIn`; a list asks those named by id or tag, in the order named; `false` asks none.
`extraLookups` adds lookups the caller holds itself. The matches of every lookup asked are joined,
exact spellings are kept when there are any, and the result is ordered by how qualified the written
reading was, then by kind.

```ts
const resolver = ctx.services.get("refs.resolver");
const picker = ctx.services.get("refs.picker");

const { refs } = await resolver.resolve({ input: "task-files", kinds: ["recipe"], lookups: ["installed", "latest"] });
const recipe = await picker.pick(refs, { search: "task-files", acceptFirst: input.acceptFirst }, ctx);
```

## Helpers for other plugins

`rulePruner()` builds a pruner from rules, `splitter()` and `finishRef()` build splitters, and
`readingsAfterRepository()`, `splitRepoUrl()`, `buildCanonicalRepository()` and `defaultLocator()`
are the location rules hosts share.
