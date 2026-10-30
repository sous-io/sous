# S2: Building the Config

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G1 (encapsulation), G3 (versatility, always), G4 (predictable and
observable), G6 (testability), G9 (very fast).

**Related:** S1 (the engine), S5 (config expressions), S6 (concerns, owners and the plugin list).

**Shaped by:** L1 (one owner per concern), L2 (one implementation), L3 (services never print,
prompt or exit), L5 (everything timed).

## What This Specifies

How the config is built: one loop over contributors, which config files, plugins and the
environment all take part in. The loop also loads plugins, downloads what subscribed recipes need,
and evaluates config expressions. The engine runs it before any intent, and again after a series
chain that changed the config (S1).

## Why

Before the refactor, config resolution is spread over six places:

1. Discovery, the list of config files and the env files: `BaseCommand.init`, `config-discovery.ts`,
   `env-local.ts`.
2. The merge: a separate child process, `config-kernel.mjs`, started through `spawnSync` on every
   load (first under plain Node, then again under tsx so user configs may use TypeScript). It reads
   and deep-merges each file in order, passes every layer through a JSON round-trip, and keeps its own
   smaller copy of the auto-vars list.
3. Recipe config files: read and filtered to an allowlist in `repos/recipe-config-layers.ts`, before
   the merge.
4. Built-in entries: the `sous-recipes` repository and the `core` subscription are added after the
   merge, in `repos/defaults.ts`, then validated.
5. Variables: resolved later, on demand, once per caller, by `resolveRootScope`, which also pulls in
   recipe answers.
6. A second path to the subscriptions: `subscription-service.ts` re-reads
   `conf.d/510-subscriptions.jsonc` from disk and spreads it over the merged config.

`settings.ts` alone does nine jobs: re-exports, config shape types, loading, substitution, scope
resolution, aliases, tools, compilation and watch.

Under this specification, every one of those becomes a contributor, or a service a contributor uses,
owned by one plugin (S6).

## Contributors

A contributor is anything that adds to the config. Each config file is a contributor, and so is each
plugin that changes the config.

```ts
sous.config.contribute({
    id: "diagrams",

    contribute(config) {
        if (config.atPath("diagrams.enabled").valueOr(true)) {
            config.atPath("compilation.targets").appendValue({
                id: "diagrams",
                entryGlob: "${diagrams.sourceGlob}",
                outputs: [{ destinationDir: "${projectRoot}/docs/diagrams" }],
            });
        }
    },
});
```

A plugin's defaults for its own keys live in the schema it registers for them, never in a patch (see
"No `setDefault`"):

```ts
sous.entities.add("config-key", {
    id: "diagrams",
    schema: z.object({
        enabled: z.boolean().default(true),
        sourceGlob: z.string().default("docs/**/*.mmd"),
    }),
});
```

Config files are contributors too. `plugin-config-files` finds `sous.config.*` and adds a
contributor for it. `plugin-confd` finds the `conf.d` files and adds one contributor per file, named
after the file (`confd/610-mac.jsonc`). Recipe config files, the built-in entries and the environment
come in the same way, from the plugins that own them (S6).

## The Builder

> "I think config contributors should basically return a "patch" to the config, not the modified
> config itself. If a contributor comes up in the loop again, it should be provided the config
> _without its previous modifications_, but it may have access to its previous patches, if it needs
> them. I'm trying to make it so that each contributor does not need to manage idempotency, itself."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. A contributor never edits the config. It is given a builder object, and every change it makes
   through the builder is recorded as its patch, with its name.
2. The builder has operations for arrays as well as values, such as `appendValue`, so a contributor
   never has to replace a whole array to add one item.
3. A contributor is given the config made from every other contributor's latest patch, without its
   own. It may also read its own previous patches. So no contributor has to make itself idempotent.
4. Every read through the builder is recorded: each config key read, with the value it saw, and each
   entity list or entity read, with which entries existed (their ids and plugins).
5. A contributor adds the entities the config creates through the builder (`config.addEntity`).
   They are part of its patch, so they are removed and re-added when it re-runs (S1, "Entities").
6. During config building, contributors read entities through the builder (`config.entities(kind)`,
   `config.entity(kind, id)`), never through `sous.entities`, or changes to them would not re-run
   the contributor. Sous warns when a contributor reads `sous.entities` directly.

7. Applying a config file is one merge at the root (`config.root().merge(data)`). A merge reads
   what is already at every key it touches, so the builder records a read of the whole tree, and the
   contributor monitors the whole config automatically. A contributor that wants to watch more than
   it reads may say so with `monitors`, which stays available, though no built-in plugin needs it.

    ```ts
    // plugin-confd: one contributor per file
    contribute: (config) => config.root().merge(file.data),   // reads the root, so monitors everything
    ```

8. The builder is built on sous's document-editing package (see "The Document-Editing Package"), so
   a contributor can change the config in every way that package can change a file.

```ts
contribute(config) {
    const outputs = config.atPath("recipes.skills.outputs");     // recorded as a read

    if (outputs.isArray()) {
        outputs.appendValue("${projectRoot}/.codex/skills");      // recorded in this patch
    }

    for (const target of config.entities("skill-target")) {      // recorded as a read of the list
        config.atPath("compilation.targets").appendValue({ /* ... */ });
    }
}
```

## The Loop

```ts
async function buildConfig(engine: Engine): Promise<SousConfig> {
    const patches = new Map<ContributorId, Patch>();
    const reads = new Map<ContributorId, Read[]>();

    for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const contributors = engine.contributors.sorted();      // re-sorted every pass

        const toRun = contributors.filter((c) =>
            !patches.has(c.id)                                  // new this pass
            || reads.get(c.id)!.some((read) => read.changed()), // something it read changed
        );

        if (toRun.length === 0 && !engine.plugins.loadedNewOnes()) {
            return validate(applyInOrder(contributors, patches));
        }

        for (const contributor of toRun) {
            const view = new BuilderView(applyInOrder(contributors, patches, { without: contributor }));

            await contributor.contribute(view);

            patches.set(contributor.id, view.patch);
            reads.set(contributor.id, view.reads);
        }

        await engine.plugins.loadFrom(applyInOrder(contributors, patches).plugins);
    }

    throw new ConfigError("The config did not settle", /* the reads that kept changing */);
}
```

Rules:

1. Contributors run in name order, adjusted by their `before` and `after` declarations (see "Order
   and stages"). The list is re-sorted every pass, so a contributor found partway through takes its
   sorted place, not the end of the list.
2. Each pass starts from an empty config and applies the stored patches in the sorted order of
   rule 1 (earlier stages first), each contributor's latest patch once, so an array append is
   never doubled. A contributor that re-runs keeps its place: re-running replaces its patch, and
   never moves it.
3. The user's files win because they sort last: the `sous.config.*` contributor and each `conf.d`
   contributor declare `after: ["*"]`, which puts them after every contributor that is not one of
   the user's files, and their patches land on top. They monitor the whole config, so any change in
   a pass re-runs them, and they see it (see "Order and stages").
4. A contributor re-runs only when a key or entity it read has changed since its last run. The
   others keep their stored patches.
5. A patch that replaces a value (a scalar, or an object whole) hides an earlier patch's value for
   that key. A patch that only adds keys beside it hides nothing.
6. The loop ends when nothing anyone read has changed, and no new contributor or plugin appeared.
7. The number of passes has a limit (10, for example). Going over it is an error naming the values
   that kept changing, the contributors they came from and the values they alternated between.
8. A contributor must give the same result for the same input.
9. Validation runs last, after values resolve, so a value built from a variable is checked.
10. Every pass and every contributor run is timed (L5).
11. No events fire while the config is being built (S1).

```text
pass 1:  contributors [config-files:sous.config.jsonc, plugin-recipes, skills]
         skills reads skill-target entities: [claude-code]
         plugin-recipes loads sous-plugin-codex, which adds skill-target "codex"
pass 2:  contributors [config-files:sous.config.jsonc, plugin-recipes, sous-plugin-codex, skills]
         skills re-runs: the skill-target list it read changed
pass 3:  nothing anyone read changed → done
```

### Order and stages

**`before` and `after`** sit on contributors. A plugin may declare them too, as the default for every
contributor it adds. A name in either list may be a plugin (all its contributors), a contributor id,
or a wildcard. Their purpose is speed: running a contributor after the ones it reads saves a pass.

Because patches apply in the sorted order, `before` and `after` also decide which of two
contributors wins when both set the same key: the one sorted later lands on top, however often
either re-runs. The user's files rely on that, and nothing else does on purpose.

**`"*"`** in `after` means every contributor that does not itself declare `after: ["*"]`, so a
contributor declaring it sorts after all of those, in its stage. Among the contributors that
declare it, their other declarations and their names decide. A contributor that names one of them
explicitly keeps its own declaration: `after: ["confd/*"]` still runs after the `conf.d` files.
`before: ["*"]` is the mirror image.

```ts
export default definePlugin({
    name: "plugin-claude-code",
    after: ["plugin-skills"],                    // default for every contributor this plugin adds

    register(sous) {
        sous.config.contribute({
            id: "claude-code/defaults",          // inherits: after plugin-skills
            contribute(config) {
                // ...
            },
        });

        sous.config.contribute({
            id: "claude-code/late-fixups",
            after: ["confd/*"],                  // its own: after every conf.d file
            contribute(config) {
                // ...
            },
        });
    },
});
```

**The user's files land last.** `plugin-config-files` adds a contributor for `sous.config.*`, and
`plugin-confd` adds one contributor per `conf.d` file. Each declares `after: ["*"]`, so it sorts
after every plugin's contributor, and its patch applies after theirs. Each applies its file as one
merge at the root, so each monitors the whole config automatically (rule 7 of "The Builder"). Any
change in a pass, by any plugin, re-runs them, so they see it. Re-running costs little, since the
files are already parsed, and it stops on its own: a file that re-runs and produces the same patch
changes nothing, so nothing is triggered again.

Among themselves, the files keep today's order through `after`: the `sous.config.*` contributor
comes first, and each `conf.d` contributor names the file before it, so `conf.d` files run, and
their patches apply, in file order, after `sous.config.*`, in every pass.

```ts
// plugin-confd
let previous = "config-files.main";                    // the sous.config.* contributor

for (const file of listConfdFiles(project)) {          // sorted the way conf.d sorts today
    const id = `confd/${file.name}`;

    sous.config.contribute({
        id,
        after: ["*", previous],                        // after every plugin, then file order
        contribute: (config) => config.root().merge(file.data),
    });

    previous = id;
}
```

```text
each pass:  plugins … → sous.config.* → confd/500-repos → confd/510-subscriptions → confd/610-mac
```

Worked through with a real file. `sous-plugin-acme-standards`, shipped in a recipe, turns source
comments on; the project's `sous.config.js` turns them off:

```ts
// sous-plugin-acme-standards
contribute(config) {
    config.atPath("compilation.includeSourceComments").setValue(true);
}
```

```js
// .sous/sous.config.js (excerpt)
compilation: {
    includeSourceComments: false,
},
```

```text
acme's contributor sets includeSourceComments = true, which changes the config
→ the sous.config.* contributor re-runs; it sorts after acme, so its merge lands on top: false
result: false. In a project whose files don't set it: true.
```

```text
pass 1:  plugin-skills        adds compilation targets for .claude/skills
         confd/610-mac        patch applied on top
         plugin-recipes       loads sous-plugin-codex, which adds skill-target "codex"
pass 2:  plugin-skills        re-runs: the skill-target list changed; adds a target for .codex/skills
         confd/610-mac        re-runs: the config changed; it still sorts last, so its patch stays on top
pass 3:  nothing changed → done
```

**Stages.** A contributor may declare a stage: any number, default `0`. The goal is to keep
everything in stage 0, but adding stages is cheap.

```ts
sous.config.contribute({
    id: "team-policy",
    stage: 7,
    contribute(config) {
        config.atPath("compilation.overwriteUntracked").setValue(false);
    },
});
```

1. Stages run from the lowest number to the highest. Each runs the loop above until nothing changes;
   then the next stage starts from the config the earlier stages produced.
2. A finished stage never runs again.
3. A plugin loaded during stage N has every stage it declares shifted by N: its stage-0 contributors
   run in stage N, its stage-2 contributors in stage N + 2. This nests, so no contributor lands in a
   stage that has already finished.
4. Contributors of finished stages stay watched. When something one of them monitors changes, sous
   logs, at the `debug` level (S1, "Log levels"), that it would have re-run and why it did not:

    ```text
    plugin-x, running in config stage 7, changed recipes.skills.outputs, which would have made
    plugin-y re-run, but plugin-y is in stage 0, so it didn't.
    ```

The user's ruling on what a later stage is for:

> "the whole point of putting something in a later stage is specifically to have it process after
> everything else. [...] At some point, people have to learn how the engine works."
>
>   -- **Luke Chavers** in an agent session (2026-10-29)

### Plugins load inside the loop

The plugins to load are an ordinary config key (`plugins`, S1). After each pass, the engine loads
the plugins the config now lists, and their contributors join the next pass. A plugin removed from
the list in a later pass stays in memory, since its code cannot be unloaded, but its contributors no
longer run and their patches are dropped.

### Downloads

> "there will be a plugin called `plugin-recipes` (or whatever); it will download whatever it needs,
> do whatever it needs to do, then the loop continues."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

`plugin-recipes` is a contributor that downloads the subscribed recipes the config needs, so their
config files, plugins and content can join the loop. Downloads are cached, so later passes find them
already there. On a machine with no network and nothing downloaded yet, building the config fails
and says what it could not download.

### Speed

> "every "build config" step should be fast as fuck... with exceptions when something is missing."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

A config whose contributors read nothing that later changes settles in one pass. Re-running only
the contributors whose reads changed keeps later passes short.

### "What if" builds

The engine can build a separate config on request, with extra contributors, without replacing the
real one: for previewing a recipe update, or trying another value for a variable. It gets its own
`config`-lifetime services (S1).

```ts
const preview = await ctx.engine.buildConfig({
    extraContributors: [pinRecipeVersion("workflow/github-projects", "1.3.0")],
});
```

## Config Files

### No child process

`plugin-config-files` and `plugin-confd` load every file in-process. `config-kernel.mjs` goes away.

- `.json`, `.jsonc` and `.yaml` files are parsed; `.js` and `.ts` files are imported in the main
  process.
- A `.js` or `.ts` file exports `configure(config)`, and is given the builder, like any contributor.
  It runs again whenever it re-runs, and must give the same result for the same input.
- Node cannot unload an imported ES module, so when a `.js` file changes on disk, it is imported again
  under a new URL, and the old copy stays in memory. This small leak per reload only affects watch
  mode and long-running processes.
- A file is read from disk once per build; re-running its contributor in a later pass reuses what was
  read.

### Config expressions are part of the same loop

Config expressions (S5) are evaluated inside each file's contributor, before its values go into its
patch, so an expression never meets a merge. Before this specification, a separate loop re-evaluated
each file and repeated until no expression read a variable whose value then changed. That loop is
now this one: every variable an expression reads is recorded as a read, and the file's contributor
re-runs when that variable's resolved value changes.

1. An expression sees the variables resolved from the other contributors' latest patches, plus its
   own file's plain `_vars`.
2. LiquidJS lists the variables an expression reads without running it, so sous knows which reads to
   record.
3. A variable unknown during a pass is `undefined`. If it is still unknown when the config settles,
   that is an error naming it.

Example: a subscription switched off on a Mac only.

```jsonc
// conf.d/510-subscriptions.jsonc (sous writes this)
{
    "subscriptions": {
        "tool-usage/automated-browser-tasks": {
            "range": "^2.1.0",
            "prerelease": false,
            "alwaysPull": true,
            "addedAt": "2026-10-12T14:03:00Z",
            "addedBy": "user"
        }
    }
}
```

```jsonc
// conf.d/610-mac.jsonc (the user writes this)
{
    "subscriptions": {
        "tool-usage/automated-browser-tasks": {
            "enabled": {
                "$if": {
                    "expr": "host.platform == 'darwin'",
                    "then": false
                }
            }
        }
    }
}
```

```text
Mac      610 evaluates to { enabled: false }; applied key by key, every 510 field survives
Linux    610's condition is false and there is no $else, so enabled is undefined and dropped;
         610 contributes {} and the subscription stays on
```

Example: a variable set in a later file.

```text
Files: sous.config (machineRole: laptop) → 610-browser ($if machineRole == 'laptop') → 700-ci (machineRole: ci)

Pass 1   610-browser reads machineRole → "laptop" → enabled: true; 700-ci then sets "ci"
Pass 2   610-browser re-runs: machineRole now resolves to "ci" → enabled: false
Pass 3   nothing it read changed → done
```

### Variable scopes

`_vars` may be set at four levels, each inheriting the levels above it, inner values winning:

```text
root _vars
└── compilation._vars
    └── compilation.targets[]._vars
        └── targets[].outputs[]._vars
```

An expression sees the `_vars` of every level that contains it, and no others. An expression under
`subscriptions`, `repos` or any other top-level key sees only the root `_vars`. Recipe outputs also
get a scope per recipe, holding that recipe's answers.

### Recipe answers

No expression under `subscriptions` or `repos` may read a recipe's answers: which recipes are pinned
depends on the subscriptions, so switching a subscription off would remove the answer that switched
it off. Doing so is an error:

```text
Error: subscriptions."workflow/github-projects".enabled reads githubProjectId,
which is an answer to a recipe. An expression that decides which recipes are
subscribed or pinned (anything under "subscriptions" or "repos") cannot read
recipe answers.
  in conf.d/610-team.jsonc
```

Everywhere else, expressions may read recipe answers.

## Rulings That Still Hold

### Sous always reads the built config

> "510 is not special outside of how it affects config loading and outside of the fact that Sous
> generally manages the 5?? files. Because Sous' config can be very complex, very very complex, Sous
> should _always_ rebuild the shared config when pulling information from it. Assuming that 510 is a
> special source of subscription info is a party foul, outright!"
>
>   -- **Luke Chavers** in an agent session

No code treats one config file as special. An intent that writes a managed file is part of a series
chain, and the engine rebuilds the config after it (S1); nothing re-reads the file itself.

### Sous's edits to the files it manages are surgical

> "user edits to the 500 files should _generally_ be preserved. Even though Sous owns those files,
> its edits should be surgical. Each edit Sous makes to those files should precisely follow Sous'
> intent. [...] If we add a command (and we should, btw) that was `sous subscription disable <ref>`
> then I would expect Sous to overwrite my condition. Same with `enable`. However, if I add another
> subscription, I would expect Sous to keep that line as-is; only adding the new sub."
>
>   -- **Luke Chavers** in an agent session

Managed files are edited key by key, by intents, never by contributors. `sous subscription disable
<ref>` and `enable <ref>` are added.

### The robustness principle

> "We want to apply the robustness principle: we will accept _many_ different forms of the same
> thing."
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

Sous accepts many forms when reading config, and writes one form.

### Plugins add config keys

The keys the config may hold are `config-key` entities. A plugin adds the keys it owns, with their
schema, and validation rejects unknown keys:

```ts
sous.entities.add("config-key", {
    id: "diagrams",
    schema: z.object({
        enabled: z.boolean().default(true),
        sourceGlob: z.string(),
        outputDir: z.string(),
    }),
});
```

### Where a value came from

Every change goes through the builder, which records which contributor made it, so errors name the
file or plugin, and `sous config get --layers` lists every change to a key, in order, with its author
(G4).

### Plain JSON data

The config is always plain JSON data, so `sous config show` can print it exactly, `sous mcp` can
send it, and a cache can store it. A value put into a patch passes through a JSON round-trip: a
`RegExp`, a function or a `Date` is dropped, and a regular expression is written as a string
`/.../`. Config expressions rely on `undefined` values being dropped. Entities are not config data:
they hold functions, and live beside the config.

### Where the other settings go

Aliases, tools, compilation and watch settings belong to the plugins that use them (S6). Each adds
its own `config-key` entities and reads the built config.

## What `sous config show` and `get` Print

`config show` and `config get` are intents, run after the config is built.

- `show` and `get` print evaluated values: what sous will do on this machine.
- `--layers` shows each contributor's change to the value, in order: for a config file, the
  expression as written, what it evaluated to and the values it read; then the result and the number
  of passes.
- `--raw` prints each config file as written, in order.

```text
$ sous config get subscriptions."tool-usage/automated-browser-tasks".enabled --layers
conf.d/510-subscriptions.jsonc   (not set)
conf.d/610-mac.jsonc             { "$if": { "expr": "host.platform == 'darwin'", "then": false } }
                                 → false   (host.platform = "darwin")
result                           false     (settled after 1 pass)
```

## Patches

1. Every operation a contributor performs through the builder ends up as primitive operations. One
   primitive is a `Patch`. The primitives:

    | `op` | What it does |
    | --- | --- |
    | `setKey` | sets one key of an object |
    | `deleteKey` | deletes one key of an object |
    | `renameKey` | renames one key of an object |
    | `setIndex` | sets one item of an array |
    | `insertAt` | inserts one item into an array |
    | `removeIndex` | removes one item from an array |

2. Every other operation is a helper built on the primitives. Reading through the builder records
   the read; the helper then looks at the current value and emits primitives. `removeWhere` finds
   each matching item and emits one `removeIndex` per match, from the highest index down, so earlier
   removals do not shift later ones. Plugins may write helpers of their own (L7).

    ```ts
    config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
    // compilation.targets is now monitored; the item at index 7 matches, so the helper records:
    // { "op": "removeIndex", "path": "compilation.targets", "index": 7 }
    ```

3. An index a helper computed never goes stale: the contributor read the array to compute it, so
   if anyone changes that array, the contributor re-runs and computes it again.
4. A `PatchSet` holds `Patch`es and other `PatchSet`s. A helper's work is a named `PatchSet` of its
   primitives, and one contributor run produces one `PatchSet`. The engine keeps an outer list of
   contributors' `PatchSet`s, in the sorted order of the contributors, and applies it to an empty
   config on every pass. A re-run replaces that contributor's `PatchSet` in its place.
5. Since every `Patch` is a primitive over plain JSON values, any `PatchSet` serializes to JSON and
   back. A `PatchSet` can be saved, sent over MCP or to a web front end, previewed, and applied
   later.
6. `sous config show --layers` shows both levels:

    ```text
    confd/620-no-diagrams.js
      removeWhere compilation.targets                  ← a PatchSet
        removeIndex compilation.targets[7]             ← a Patch
    ```

### Patch files

`plugin-config-files` and `plugin-confd` also read files of raw patches, such as
`conf.d/720-my-special-thing.patch.json` and `conf.d/721-my-list-of-things.patch.jsonl`. Such a file
is a contributor whose operations come from the file instead of being computed.

1. A `.patch.json` file holds one patch, unless its top-level object has a single key, `$patches`,
   holding an array: then each item is a patch.
2. A `.patch.jsonl` file holds one patch per line, so a tool or an agent can add a line without
   parsing the file.
3. An index written by hand is never recomputed: `removeIndex 7` removes whatever is at index 7 at
   that point in the pass. Key and path operations have no such edge. Patch files are for people who
   know how the engine works.

```jsonc
// .sous/conf.d/720-my-special-thing.patch.json: several patches, so a single $patches key
{
    "$patches": [
        { "op": "setKey", "path": "compilation", "key": "overwriteUntracked", "value": false },
        { "op": "deleteKey", "path": "tools", "key": "codex" }
    ]
}
```

```jsonc
// .sous/conf.d/722-one-thing.patch.json: one patch
{ "op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop" }
```

```jsonl
// .sous/conf.d/721-my-list-of-things.patch.jsonl: one patch per line
{"op": "insertAt", "path": "compilation.targets", "index": 0, "value": {"id": "first", "entryPoint": "a.tpl.md"}}
{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}
```

The user's ruling on patch files and their edge:

> "if a user is diving that deep, they need to understand the engine. I just wanted to grab this
> freebie."
>
>   -- **Luke Chavers** in an agent session (2026-10-29)

## No `setDefault`

The builder has no `setDefault`. Two things already cover every case found:

1. A plugin's defaults for its own keys live in the schema it registers (`.default(...)`), and are
   filled in when the finished config is checked. A plugin never writes to its own part of the
   config just to supply a default.
2. A plugin that suggests a value for a key someone else owns uses an ordinary set. The user's files
   sort after every plugin and re-run after any change, so their patches land on top, and the
   user's value wins whenever there is one.

The only case `setDefault` would add is two plugins setting one key, with one meant to give way to
the other. No real case was found; it can be added later if one appears.

## The Document-Editing Package

Plugins must be able to change the config surgically, in many different ways. The same need exists
for files outside the config: sous plans to edit JSON and YAML files other tools own, such as Claude
Code's settings files, and already edits its own managed `conf.d` files key by key, keeping the
user's comments and formatting (see "Sous's edits to the files it manages are surgical").

So one package, `documents` (S6), edits a JSON, JSONC or YAML document surgically, keeping comments,
key order and formatting. The config builder is that package plus read recording and patches. The
managed `conf.d` edits, and any plugin editing another tool's file, use the package directly, through
a service.

The operations it needs, at least:

```ts
const node = doc.atPath("compilation.targets");

// Inspecting
node.exists();
node.type();                   // "object" | "array" | "string" | "number" | "boolean" | "null"
node.isArray();
node.isObject();
node.get();
node.valueOr(fallback);

// Objects and values
node.set(value);
node.delete();
node.rename("newKey");
node.merge(object);            // key by key; arrays joined
node.replace(object);          // whole
doc.atPath("tools").keys();

// Arrays
node.append(item);
node.prepend(item);
node.insertAt(2, item);
node.removeAt(2);
node.removeWhere((target) => target.id === "diagrams");
node.upsertWhere((target) => target.id === "diagrams", item);   // replace the match, or append
node.findWhere((target) => target.id === "diagrams");           // a node for the match, to edit in place
node.atIndex(0);
node.move(from, to);
node.dedupe();

// The whole document
doc.root().merge(data);
doc.toString();                // the edited text, comments and formatting kept
```

Inside a contributor, every read is recorded as a read, and every change ends up as primitive
`Patch`es (see "Patches"). The same `Patch`es can describe an edit to any file, so a file edit can be
previewed or dry-run before it is written.

## Open Questions

None.

## Changes

### 2026-10-29: Patches apply in the sorted order, and a re-run no longer moves a patch

Made by the agent while the user was away; needs Luke's review.

**What changed.** Rules 2 and 3 of "The Loop", and "Order and stages". Patches used to apply in the
order their contributors last ran, and a contributor that re-ran moved its patch to the end; the
user's files landed on top because they re-ran last. Now patches apply in the sorted order (names,
`before` and `after`, stages), and a re-run keeps a patch in its place. The user's files land on top
because they declare `after: ["*"]`, which sorts them after every contributor that is not one of the
user's files, and then their own file-order chain. `"*"` is new.

**Why.** With every file monitoring the whole config, the old rule never settled when a file read
a variable that a later file set. The example in "Config expressions are part of the same loop":

```text
sous.config.jsonc     _vars.machineRole = "laptop"
conf.d/610-browser    reads machineRole
conf.d/700-ci         _vars.machineRole = "ci"
```

Every change re-ran all three files. Whichever of `sous.config.*` and `700-ci` re-ran last moved to
the end and won, so `machineRole` flipped between "laptop" and "ci" on every pass, `610-browser`
re-ran each time, and the build stopped at the pass limit. With a stable order, `700-ci` always
applies after `sous.config.*`: `610-browser` sees "ci" in pass 2 and the build settles in pass 3.
The outcome the user asked for is the same (the user's files win, in file order); it is now
deterministic and always settles.
