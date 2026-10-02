# ADR 0012: One ref resolver, and recipe memories included through a `#memories` view

**Status:** Accepted, 2026-10-02.

This record supersedes [ADR 0008](0008-one-ref-parser.md) (one ref parser, told where the ref came
from), and amends [ADR 0005](0005-first-project-follow-ups.md) in one place: its line saying that
whether Liquid inside an included file renders is decided by the entry point. The living answers are
[Ref forms](../repositories-file-formats.md#ref-forms), [Include syntax](../configuration.md#include-syntax)
and [Recipe memories](../repositories-consuming.md#recipe-memories). The process record is
[gh-170](https://github.com/sous-io/sous/issues/170) (One ref resolver, and recipe memories included
through a #memories view).

## Context

Refs were still read by more than one piece of code. `parseRef` read refs on the command line, in
configs, in manifests and in the lockfile, but an include line (`@~namespace/recipe/path`) was split by
a private function in the namespace resolver, and a variable name (`workflow/task-files.apiUrl`) was
matched by code of its own. The same string could mean different things in different places.

Recipe memories had a second problem. A recipe could publish a memory, but it reached an agent only
through a hand-written include line per file, and a project that subscribed and wrote no line got
nothing, silently. The user took the memory work over in the same effort:

> "2... the `memories sm` agent paused to wait on us in this session. You can take over, entirely, for that
> agent."
>
>   -- **Luke Chavers** in an agent session (2026-10-01)

## Decision

### The ref resolver

Everything about refs lives in `src/services/ref-resolver/`, and `src/lib/refs/` is gone:

> "We want to get all of the ref code in one place, such as `src/services/ref-resolver/`."
>
>   -- **Luke Chavers** in an agent session (2026-10-01)

- **One context-free parse step returns every reading of a string.** The parser does not know where the
  string was written:

  > "That function should accept a string containing a ref (and only a ref). This
  > method won't need `from` at all, because it doesnt care."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-01)

  It is an ordered list of splitters, each reading from the front of the remaining text and returning
  every reading. Query values (`?name=value`, percent-encoded) are removed first and kept on the ref;
  nothing renders them. A bare word reads as a repository, a namespace, a recipe, a variable and an
  environment variable name all at once.
- **A ref is plain data of a kind**: `repo`, `namespace`, `recipe`, `recipeFile`, `variable` or
  `envVar`, with its parents nested rather than offered as separate readings. A glob is a flag on a kind.
  Refs are never class instances, so a plugin can add a kind.
- **A second step prunes by the place the ref was written.** `RefSource` (`CommandLine`, `Config`,
  `Manifest`, `Lockfile` and the new `Include`) picks the pruner, which drops the readings that place
  refuses and says what to write there instead. This keeps the idea of ADR 0008, now as a separate
  part rather than a parameter of the parser.
- **A third step narrows against what exists.** A `RefLookup` is a queryable, asynchronous object;
  lookups chain, the first that answers wins and a failure throws. They read the cached indexes, a
  release's recorded dependency, indexes fetched for `sous repo release`, locked recipe files,
  variables and environment variable names (exact spelling only). Names match exactly first, then
  ignoring case, and the known spelling is returned, never the typed one.
- **The caller decides what ambiguity means**, helped by functions such as `getFirstRef` and
  `isValidRef`; `RefPickerService` is the shared interactive choice, and `ref-report.ts` prints what a
  reference resolved to.
- **Services are singletons, and Inversify binds the ref services.** `RefResolverService`,
  `RefParser`, `RefPickerService` and `HashNameRegistry` are injected with their splitters, pruners,
  providers and `#` names as lists bound under `REF_TOKENS`, so a plugin adds a part by binding one more
  on a container from `createRefContainer()`. Every injected parameter names its token (through
  `makeInjectable`, in `injectable.ts`) because the published bin runs through tsx, which emits no
  decorator metadata. This is the pattern the wider refactor follows (gh-48); only the ref services
  move into a container here:

  > "you're not doing the full refactor, only laying down and test a few patterns
  > as part of this work. Inversify is one of them."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-01)

### Include lines

An include path is read by the resolver as an `Include` ref. The changes to include syntax:

- **Paths may be globs**, with the full `glob` syntax `entryGlob` takes, `${var}` substituted first. A
  glob includes every file it matches, in bytewise path order, even a file the same output already
  included. Control is in config, not in the include syntax:

  > "I don't want this include syntax to devolve into a crazy-complex DSL that people have to memorize."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-01)

- **A file may be included more than once.** Cycles are still errors.

  > "rejected, users are allowed to include the same file in more than one place."
  >
  >   -- **Luke Chavers** in an agent session (2026-09-30)

- **A line that looks like an include but does not parse is a build error** naming the file and the line
  (gh-154), instead of text copied to the output.
- **`#` is a second sigil**, for names sous or a plugin registers (`HashNameRegistry`); `~` keeps meaning
  the home directory (`~/`) and recipe namespaces. `~project` becomes `#project`, with no old spelling.
  A project alias may not start with `~` or `#`, and a name registered twice is an error:

  > "I dont think that ~project is used anywhere, so I think we can just drop that and go ahead and convert to
  > #. I own 100% of all Sous-powered repos at the moment, anyway, so any breaking changes will just annoy me
  > for 1 minute."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-01)

  Project aliases are unchanged:

  > "I think we leave aliases as they are."
  >
  >   -- **Luke Chavers** in an agent session (2026-10-01)

- **`@~namespace/recipe/path` still reaches every pinned recipe**, libraries held only through `depends`
  included, and a `repo:` qualifier may start the path to name which repository.

### The `#memories` view

A view is a `#` name that lists virtual files instead of standing for directories. `@#memories/**/*.md`
includes the memories of every ACTIVE recipe (held by a subscription, directly or through a namespace or
a recipe's `subscribes`): the files matched by the include patterns of a manifest `contents` entry of
`kind: memories`, at virtual paths `#memories/<namespace>/<recipe>/<path from the entry pattern's base>`.
A recipe held only through `depends` contributes nothing.

- **Order**: a recipe comes after the recipes it depends on, ties by recipe key (bytewise), and recipes
  matching `recipes.memories.first` lead. Files within a recipe are in bytewise path order.
- **`recipes.memories.exclude` is the opt-out**: recipes it matches are not listed.
- **The build warns about every memory an active recipe publishes that no output includes**, by any route
  (an exact path, a glob or the view), except those under `exclude`. The warning names the include line
  to add. It is an ordinary warning, not escalated by `--strict`.
- **`sous init` writes its starter as `memories/AGENTS.tpl.md`**, holding the `@#memories/**/*.md` line,
  so a new project's memories reach the agent without a step the user could forget.
- **Subscribing alone does not include.** The one include line is the project's choice (gh-141 stays
  open).

This repository's own instruction source follows it: its hand-written include lines became one line.

> "1, but I dont think order will matter, so we probably wont be using `first`"
>
>   -- **Luke Chavers** in an agent session (2026-10-02)

### The `recipes` config key

One `recipes` key replaces `recipeOutputs`, which is removed with no alias, with a block per content
kind:

```js
recipes: {
  skills: { outputs: ["${claudeSkillsDir}"] },
  memories: { first: ["communication/*"], exclude: ["tool-usage/automated-browser-tasks"] },
}
```

`skills.outputs` is what `recipeOutputs.skills` was (default `<project root>/.claude/skills`).
`first` and `exclude` take globs over `namespace/recipe` keys, and a string written `/.../` is a regular
expression, because the config kernel passes every layer through JSON, which cannot carry a `RegExp`.
There is no `prompts` block; a recipe declaring `kind: prompts` gets the build's one warning that nothing
takes that kind. A recipe's own config layer may set `recipes` (it replaces `recipeOutputs` on the
allowlist).

### Rendering

Every `.tpl.` file renders as Liquid and no other file ever does, decided by the file's own name,
including a file found through its `.tpl.` twin. This supersedes the line of ADR 0005 that left it to the
entry point:

> "Every `.tpl.` should render as a liquid template, every time, IMO.. and every not-`.tpl.` should never
> render as a liquid template."
>
>   -- **Luke Chavers** in an agent session (2026-10-01)

The compiler reads the include graph first. A `.tpl.` file renders with each include line left as a
marker (so a condition around an include line still applies), every included file renders on its own by
its own name, and the results replace the markers.

## Consequences

- A project using `~project` or `recipeOutputs` fails to build until it uses `#project` and `recipes`.
  A user alias starting `~` or `#` is a config error (it was a warning).
- A plain `.md` file that carried Liquid, included from a template, now copies verbatim. No published
  recipe at a pinned version did.
- A refused ref reads "The ref 'a/b/c' cannot be written on the command line: ..." in place of "Invalid
  ref ...", environment variable names match by exact spelling only, and the catalog functions are
  asynchronous.
- Adding a ref form, kind or place is a change to one splitter, one kind or one pruner, and the specs
  under `src/services/ref-resolver/` check each.
- The integration tests `include-globs.test.ts`, `memories-view.test.ts`, `memories-warning.test.ts` and
  `per-file-rendering.test.ts` in `src/test/integration/` prove the include and rendering changes.
- Out of scope: rendering values passed to an include (gh-168), the full container refactor (gh-48) and a
  `sous doctor` check for missing memory includes.
