# S1: The Engine

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G1 (encapsulation), G2 (a plugin system), G3 (versatility, always), G4
(predictable and observable), G6 (testability), G7 (the plugin interface is the only outside
promise), G8 (features for one agent tool are additions), G9 (very fast).

**Shaped by:** L1 (one owner per concern), L3 (services never print, prompt or exit), L4 (no prompt
without a flag), L5 (everything timed).

**Related:** S2 (building the config), S6 (concerns, owners and the plugin list).

## What This Specifies

The engine sous is built on: what core holds, how sous starts, how plugins load, and the five kinds
of things plugins register (contributors, intents, events, services and entities). It is written as
an engine almost any application could be built on; what sous does is added by plugins.

The user's standing direction for the engine:

> "we want versatility... always...."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

> "I'm not especially interested in policing, only in identifying problems and reporting them, and
> in versatility."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

## What Core Holds

Core is small. Everything else, including the CLI, the MCP server, the web GUI, config files,
recipes, repositories, skills, memories, package managers and Claude Code, is a plugin (S6).

1. Loading plugins, as part of the config-building loop (S2).
2. The config-building loop: contributors, the builder object, patches, re-running only what changed
   (S2).
3. The chain scheduler: series by default, parallel when declared, and background intents.
4. Events: `on`, `once`, `off`, `emit`, wildcards and regular expressions, and priorities.
5. Services, with their three lifetimes, wrapping and replacing.
6. Entities: defining kinds, adding entries, and reading them through the builder.
7. Loop detection, and the time budgets.
8. The empty type interfaces in `@sous-io/plugin-api`: `SousServices`, `SousIntents`, `SousEvents`
   and `SousEntities`.

The engine has five kinds of things:

1. **Contributors** build the config (S2).
2. **Intents** are the steps a user or another plugin asks for.
3. **Events** let plugins react to anything.
4. **Services** are shared objects that do work.
5. **Entities** are things sous knows about, defined and added by plugins.

## The Shape: Build the Config, Then Process Intents

> "sous builds a config then enters into a mode of processing intents. For most CLI commands, this
> will be a single intent. For some CLI commands, this will be a series of intents, or a chain of
> intents that may have some intents processing in parallel. For the MCP server, this will be
> asynchronous intents coming in throughout the lifetime of the connection, etc."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. The bin hands off to the project's own installed copy of sous when there is one, starts the
   engine, builds the config (S2), and hands argv to the CLI front end.
2. Everything after the config is built is an intent, `sous config show` included:

    > "processing of `config show` is an intent. It happens after the config build."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-25)

3. A CLI command usually runs one intent. That intent may start others, some of them in parallel.
4. Waiting for more requests is not a mode of core. The MCP server, watch mode and the web GUI are
   background intents that submit new chains as requests arrive (see "Front Ends").

```ts
// bin: the whole of it
await handOffToProjectInstall();

const engine = await createEngine({ project: findProject(process.cwd()) });

await engine.buildConfig();
await engine.frontEnd("cli").start(process.argv.slice(2));
await engine.whenBackgroundIntentsReturn();
```

Every sous process serves exactly one project: the one found from its working directory. This holds
for a CLI run, for watch mode and for `sous mcp`, which serves the project it started in for its
whole life, even when the agent changes directories. A session started at a monorepo's root gets the
root's sous, even while the agent edits a subfolder that has its own `.sous/`, as a CLI run from the
root would. No project state is kept in module-level variables, so tests can run many engines in one
process.

## Chains and the Scheduler

A chain is one intent submitted to the engine, together with every intent it starts.

> "Anything that produces a chain will decide what can and cannot run in parallel. Sous itself
> should always run pending chains in series, waiting for each to complete before running another.
> We will trust that intent chains consider conflicts, etc, and specify parallelism accordingly."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

> "A chain can declare if it can run in parallel and the Sous engine will only allow chains declared
> as parallelizable (or whatever) to run at the same time. If two chains exist and one is declared
> parallelizable and the other not, then Sous will treat them both as being series."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

> "yes, parallel generally means "writes nothing that could affect other chains""
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. Whatever produces a chain decides what inside it can run in parallel, and is trusted to handle
   conflicts.
2. Chains run in series by default: each one finishes before the next starts.
3. A chain may declare itself parallel. Parallel chains may run together. A parallel chain writes
   nothing that could affect other chains; it may write something only it uses, such as its own
   cache.
4. When a series chain is waiting, no new chain starts until it has run, so a stream of parallel
   chains never holds it back forever.
5. After a series chain that changed the config, the config is rebuilt before the next chain starts.
   A running chain keeps the config it started with.

```text
time ─────────────────────────────────────────────►
config get  (parallel)  ████
build       (series)      ·waiting·███████
catalog     (parallel)        ·waiting·····██      queued behind build, not next to config get
```

## Intents

An intent is a step a user or another plugin asks for: a name and a typed input. Exactly one handler
runs it and returns a result.

```ts
sous.intents.add({
    intent: "subscription.add",
    summary: "Subscribe the project to a recipe",
    input: z.object({
        ref: z.string().describe("The recipe to subscribe to"),
        installPlugins: z.boolean().default(false).describe("Install plugins the recipe requires"),
    }),

    async handle(input, ctx) {
        const recipe = await ctx.run("ref.resolve", { ref: input.ref });

        await addSubscription(recipe, ctx);

        if (recipe.variables.length > 0) {
            await ctx.run("vars.ask", { recipe: recipe.key });
        }

        await ctx.run("build", {});

        return { subscribed: recipe.key };
    },
});
```

1. The CLI's commands and flags, and the MCP server's tools, are generated from each intent's input
   schema, so every input an intent takes is a flag (L4).
2. A handler starts other intents as it goes (`ctx.run`), so later steps can depend on earlier
   results. A chain is not written out up front.
3. An intent started inside a chain runs immediately, as part of that chain. It never enters the
   queue, since the chain is waiting for its result.
4. The engine does not check that a chain declared parallel only runs intents that write nothing.
5. An intent may be internal: not shown in the CLI or MCP, only callable through `ctx.run`.
6. Plugins may wrap an intent's handler to change what it does. Wrappers stack in plugin order.

```ts
sous.intents.wrap("build", (next) => async (input, ctx) => {
    const result = await next(input, ctx);

    return { ...result, diagrams: await renderDiagrams(ctx) };
});
```

### What an intent declares for the CLI and for agents

An intent may have a `cli` section and an `agent` section. Both are optional: without them, the
command, the tool name and their help come from the intent's name, `summary` and input schema. Every
front end reads the same declaration, each taking its own section; a web GUI reads `summary`,
`usage` and the schema too.

```ts
sous.intents.add({
    intent: "namespace.list",
    summary: "List the namespaces in your subscribed repositories",
    input: z.object({
        repository: z.string().optional().describe("Only this repository"),
        json: z.boolean().default(false).describe("Print JSON"),
    }),

    cli: {
        command: ["namespace", "list"],                 // default: from the intent name
        aliases: [
            ["namespaces", "list"],
            ["ns", "list"],
            ["list", "namespaces"],                     // across groups
        ],
        positional: ["repository"],                     // sous namespace list <repository>
        examples: ["sous ns list github.com/sous-io/sous-recipes"],
        hidden: false,
    },

    agent: {
        tool: "namespace_list",                         // default: from the intent name
        usage: "Call this before subscribing, to find which namespaces exist.",
        whenNotToUse: "Not for finding a recipe by name; use recipe_search for that.",
        hidden: false,                                  // true keeps it out of MCP
    },

    async handle(input, ctx) {
        // ...
    },
});
```

Arguments every command accepts, and the help text of a command group, are entities, so any plugin
can add its own:

```ts
sous.entities.add("cli-global-argument", {
    id: "verbose",
    schema: z.boolean().default(false),
    description: "Print more detail",
});

sous.entities.add("cli-group", {
    id: "repo add",
    command: ["repo", "add"],
    summary: "Add a recipe repository",
});
```

1. Command groups nest to any depth (`sous repo add alternate ...`).
2. Aliases are for the CLI only; MCP ignores them.
3. Two intents claiming the same command or alias is an error naming both plugins. The config can
   pick the winner, as it can for replaced services (L6).
4. More fields can be added later without breaking any plugin, since every section is optional.

## Events

> "we want to allow plugins to fire arbitrary events, and listeners to be able to monitor for them."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

```ts
sous.on("build.before", listener);                         // exact name
sous.on("build.*", listener);                              // wildcard
sous.on("*.before", listener);                             // every intent's "before"
sous.on(/^subscription\.(add|remove)\.after$/, listener);  // regular expression
sous.once("config.built", listener);                       // runs once, then removes itself
sous.off("build.before", listener);

sous.on("build.before", listener, { priority: 100 });      // higher runs first; default 0

await sous.emit("diagrams.rendered", { files });           // any plugin may fire any event
```

```ts
sous.on("build.before", async (event, ctx) => {
    event.input.prune = false;                              // change the input
    event.cancel("Recipe X needs sous-plugin-diagrams");    // the intent does not run; the reason is reported
    event.stopPropagation();                                // later listeners don't see it; the intent still runs
    event.data.set("startedAt", Date.now());                // shared with later listeners and the "after" event
});

sous.on("build.after", (event) => {
    event.result = { ...event.result, note: "pruned 3 files" };   // replace the result
});

sous.on("build.error", (event) => {
    event.recover({ built: 0 });                            // turn the failure into a result
});
```

1. Each intent fires `<intent>.before`, `<intent>.after` and `<intent>.error` every time it runs,
   whoever started it.
2. A listener gets a `ctx` like a handler's, so it can run intents, read the config and report.
3. `emit` waits for every listener, so a custom event can be cancelled too.
4. Listener order: `priority` (higher first), then plugin order, then the order listeners were
   added, so the outcome is the same on every run.
5. A listener that throws fails the intent. Cancelling is how a listener stops something on purpose.
6. No events fire while the config is being built; contributors are how plugins take part in it
   (S2). Plugins may register intents and listeners as they load, and `config.built` fires once the
   config is built.
7. A `config.built` listener may run an intent that changes the config. That is not the recommended
   approach, and the engine does not forbid it; loop detection catches it going wrong.

## Finding Loops

The engine identifies problems and reports them; it does not police plugins.

> "we may have a tolerance for 10 config rebuilds in a row if the config actually changes 10 times,
> but only 5 if the config hasnt changed, since that is likely unexpected recursion. We can also
> monitor recursion depth, etc."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

It stops and reports when one of these goes over its limit. The limits are first guesses, and a
project may change them, like time budgets:

| What is happening | Likely meaning | Limit |
| --- | --- | --- |
| Rebuilds in a row, each producing a new config | settling down legitimately | 10 |
| Rebuilds in a row that produce a config already seen (same hash) | going in circles, or no change at all | 5 |
| `ctx.run` calls nested inside each other | deep recursion | 32 levels |
| The same intent called again, with the same input, inside its own call | a recursion bug | 2 |
| An event emitted again while its own listeners are still running | a listener that triggers itself | 5 levels |

Every `ctx.run` and every event passes through the engine, so the report shows the whole path:

```text
Error: the config is going in circles (it was the same as 2 rebuilds ago, 5 times).
  config.built → sous-plugin-foo listener → intent "subscription.enable" (enabled: true)
  config.built → sous-plugin-bar listener → intent "subscription.disable" (enabled: false)
  The two plugins keep undoing each other's change to subscriptions."workflow/x".enabled.
```

## Services

A service is a shared object that intents and other services call: the git runner, the HTTP client,
the Liquid engine, the variable resolver.

1. An intent is a meaningful step with plain-data input and output, worth letting plugins hook into.
   A service is for the rest: its calls fire no events, so it stays fast, and its inputs and results
   need not be plain data. Finding files, for example, is a service: it is called often, and nobody
   needs to hook it.
2. Every service has one of three lifetimes:
   - `singleton`: one for the whole process, for services that never look at the config;
   - `config`: one per config build, shared by every chain using that config, and rebuilt after the
     config is rebuilt;
   - `factory`: a new one on every get, so nothing is shared.

    > "or, IMO, better worded, "into singletons and factories""
    >
    >   -- **Luke Chavers** in an agent session (2026-10-28), naming the lifetimes

3. Services are created when first used, after the config is built. A running chain keeps the
   services of the config it started with, and a "what if" config build (S2) gets its own copies.
4. Plugins may wrap a service. Wrappers stack in plugin order.
5. Plugins may replace a service. When two plugins replace the same service, sous stops with an
   error, unless the config picks one (`services.replace."<name>": "<plugin>"`). Then sous warns on
   every run that the other plugin may not work as expected.

    > "sure, its an edge case, but we give the user an escape hatch. I would only say, though, that
    > doing that will likely have unintended side-effects."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-28)

```ts
sous.services.add("git.runner", () => new GitRunner(), { lifetime: "singleton" });

sous.services.add("variables.resolver", (config) => new VariableResolver(config.get("_vars")), {
    lifetime: "config",
});

sous.services.add("liquid.engine", (config) => createLiquidEngine(config), {
    lifetime: "factory",
});

sous.services.wrap("git.runner", (inner) => new LoggingGitRunner(inner));
```

```text
Error: two plugins replace "git.runner": sous-plugin-fast-git and sous-plugin-git-lfs.
  Choose one in the config:  services.replace."git.runner": "sous-plugin-fast-git"

Warning: services.replace picks sous-plugin-fast-git for "git.runner".
  sous-plugin-git-lfs's replacement is ignored, and the plugin may not work as expected.
```

## Entities

An entity is a thing sous knows about, such as a harness, a skill target, a memory target, a
repository host or a config key. A service does work; an entity is described.

```ts
// plugin-harnesses defines a kind, with its schema
sous.entities.define("harness", z.object({
    id: z.string(),
    launch: z.function().optional(),
    runHeadless: z.function().optional(),
    readTranscript: z.function().optional(),
}));

// plugin-claude-code adds one; launch reads the user's settings when it runs
sous.entities.add("harness", {
    id: "claude",
    launch: (args, ctx) => {
        const settings = ctx.config.get("tools.claude");

        return spawnInteractive(settings?.command ?? "claude", [
            ...(settings?.args ?? []),
            ...args,
        ], ctx);
    },
    runHeadless: (prompt, ctx) => sdkQuery(prompt, ctx),
    readTranscript: (result) => toTranscript(result),
});

// plugin-harnesses, in its "launch" intent
const harness = ctx.entities.get("harness", input.harness ?? "claude");

await harness.launch(input.args, ctx);
```

1. A plugin defines a kind of entity, with a schema. Sous checks every entry when it is added.
2. Entities are added during config building, in two ways:
   - a plugin's `register()` adds entities whose existence does not depend on the config;
   - a contributor adds entities the config creates (`config.addEntity`, S2).
3. Anything about an entity that depends on the config is a method, called after the config is
   built, with a `ctx` that holds the config.

    > "we probably want to allow configuration settings to affect the entities. [...] I guess it's
    > ok, though, as long as entity and service definitions expose methods, that run later, and can
    > be injected with the config?"
    >
    >   -- **Luke Chavers** in an agent session (2026-10-29)

4. During config building, contributors read entities through the builder, so they re-run when an
   entity they read changes (S2).

## Names

```text
services   <plugin>.<thing>        git.runner   variables.resolver
intents    <plugin>.<verb>         diagrams.render   subscription.add   mcp.serve
events     <intent>.before/.after/.error, or <plugin>.<past tense>     build.after   diagrams.rendered
entities   <kind>                  harness   skill-target   memory-target   config-key
```

- The first part names the plugin that owns it.
- Custom events use the past tense, so `diagrams.rendered` is never confused with `diagrams.render`.
- A name starting with another plugin's prefix is allowed; sous warns once, naming both plugins.

## Types Across Plugins

`@sous-io/plugin-api` declares four empty interfaces: `SousServices`, `SousIntents`, `SousEvents` and
`SousEntities`. A plugin adds its own entries to them (TypeScript declaration merging), and a plugin
that imports its types sees them. At runtime, everything is looked up by its string name, so two
copies of a package never confuse anything.

```ts
// sous-plugin-diagrams/src/types.ts
declare module "@sous-io/plugin-api" {
    interface SousServices {
        "diagrams.renderer": Renderer;
    }

    interface SousIntents {
        "diagrams.render": {
            input: { only?: string };
            result: { rendered: number };
        };
    }

    interface SousEvents {
        "diagrams.rendered": { files: RenderResult[] };
    }
}
```

```ts
// sous-plugin-docs-site/src/index.ts
import type {} from "sous-plugin-diagrams/types";

export default definePlugin({
    name: "sous-plugin-docs-site",
    dependsOn: { "sous-plugin-diagrams": "^1.0.0" },

    register(sous) {
        sous.on("diagrams.rendered", async (event, ctx) => {
            event.payload.files;                                      // RenderResult[]
            const renderer = ctx.services.get("diagrams.renderer");   // Renderer
            const result = await ctx.run("diagrams.render", {});      // { rendered: number }
        });
    },
});
```

1. The types come from a type-only import, needed when compiling, not at run time. The runtime
   guarantee comes from `dependsOn` (see "Plugins").
2. A wildcard listener gets a union of every matching event TypeScript knows about. A regular
   expression listener gets `unknown`, and narrows by `event.name`.
3. Plugins meant for other plugins to use generally come from npm. A recipe plugin may still ship a
   `.d.ts` file next to its bundle. Sous copies every recipe plugin's `.d.ts` file, from the locked
   version it loads, into `.sous/types/`, with an `index.d.ts` that references them all, and rewrites
   it on every build. A project or recipe repository that writes a plugin includes `.sous/types` in
   its `tsconfig.json`. A recipe plugin with no `.d.ts` still works; plugins using it get `unknown`
   for its entries.

## Front Ends

> "if the CLI and MCP can be plugins, I'd prefer that, too."
>
>   -- **Luke Chavers** in an agent session (2026-10-28)

1. The CLI (`plugin-cli`) and the MCP server (`plugin-mcp`) are plugins, and so is a web GUI. Core
   never knows a terminal exists.
2. A front end hands its reporter and prompter over with each chain it submits. `ctx.reporter` and
   `ctx.prompter` inside that chain are the ones it came with, so each chain's output and questions
   go back to whoever asked (L3).
3. Every front end can do anything any other front end can, because they all submit the same
   intents:

    > "ideally that web gui we'll be building will allow the user to do anything that they could do
    > via the CLI or an AGENT could do from mcp, and more.. so, yes, we want versatility...
    > always...."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-28)

4. A background intent (`background: true`), such as `mcp.serve`, watch mode or `web.serve`, runs
   outside the scheduler: it never blocks a chain, and nothing waits for it. It cannot use
   `ctx.run`, since it is not inside a chain; it submits chains, and each one is scheduled normally.
   The process stays alive until every background intent has returned.
5. A background intent reads `ctx.engine.config`, which is always the config as of the latest
   rebuild, and may call services directly. Live rendering on every keystroke, for example, is not a
   chain. Only things that write go through submitted chains.
6. A background intent may ask for a "what if" config build (S2), for previews.

```ts
// plugin-cli
sous.frontEnds.add({
    id: "cli",
    async start(engine, argv) {
        const result = await engine.submit(intentFromArgv(argv), {
            reporter: new TerminalReporter(),
            prompter: new TerminalPrompter(),
        });

        printResult(result);
    },
});
```

```ts
// plugin-mcp: `sous mcp` is an intent like any other
sous.intents.add({
    intent: "mcp.serve",
    background: true,

    async handle(input, ctx) {
        const server = new McpServer();

        server.onToolCall((call, client) =>
            ctx.engine.submit(intentFromToolCall(call), {
                reporter: new McpReporter(client),          // MCP logging
                prompter: new ElicitationPrompter(client),  // MCP elicitation
            }),
        );

        await server.runUntilClosed();
    },
});
```

### The CLI foundation

Ruled 2026-10-29: `plugin-cli` uses a CLI foundation of our own, built on Node's `util.parseArgs`.
oclif is dropped. oclif expects one class per command in its own files; the commands here are
generated from intents, and adding them to oclif would depend on its internals. Loading every command
module for `--help` also works against the 150ms startup budget (G9).

`plugin-cli` generates, from the intents' declarations:

- the command tree, with nested groups and aliases;
- flags and positional arguments, from the input schema;
- `--help`, shell completion, and "did you mean" suggestions for a mistyped command.

A command's code loads only when it runs, so `--help` and shell completion stay fast.

### Log levels

The reporter's output method takes an optional level, using the syslog names in full: `debug`,
`info`, `notice`, `warning`, `error`, `critical`, `alert` and `emergency`.

```ts
ctx.reporter.log("debug", "plugin-skills re-ran: the skill-target list changed.");
ctx.reporter.log("warning", "Recipe X declares a variable no template reads.");
```

Every CLI command accepts `--log-level <level>`, which shows messages at that level and above, and
`--debug`, which means `--log-level debug`. Both are `cli-global-argument` entities of `plugin-cli`.

## Plugins

A plugin is a module that registers contributors, intents, listeners, services and entities.

```ts
export default definePlugin({
    name: "sous-plugin-diagrams",
    version: "1.0.0",

    // Other plugins this one needs, with version ranges.
    dependsOn: {
        "@sous-io/plugin-skills": "^1.0.0",
    },

    // Only affects speed and who wins conflicts: run my contributor after skills' (S2).
    after: ["@sous-io/plugin-skills"],

    register(sous) {
        sous.config.contribute({ id: "diagrams", contribute(config) { /* S2 */ } });
        sous.intents.add({ intent: "diagrams.render", /* ... */ });
        sous.on("build.after", async (event, ctx) => { /* ... */ });
    },
});
```

### Loading

> "a low-key goal of mine is to eliminate the need for the "boostrap config" and having the
> "discovery plugin" separate."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. The plugins to load are an ordinary config key, and loading them is part of the config-building
   loop (S2). There is no bootstrap section, no `"sous"` key in `package.json` and no separate
   discovery step.
2. The built-in plugins load first. A plugin that finds other plugins (scanning `node_modules`, for
   example) is a contributor that adds to the `plugins` key; the loop loads what it adds and repeats.
3. `register()` runs when the plugin loads, during config building.
4. A plugin's code cannot be unloaded once imported. A plugin removed from the list in a later pass
   stays in memory, but its contributions are dropped (S2).

The four plugin settings ruled for 1.0.0 stay, as ordinary config keys under `plugins`, which any
contributor may set, a recipe included. Adding one is a change to this specification:

- `discover` (`"dependencies" | "scan" = "dependencies"`): `"dependencies"` loads the built-ins, the
  plugins in the project's `package.json` dependencies (and the workspace root's) and those under
  `load`; `"scan"` also asks the package-manager plugins to look for installed plugins.
- `load` (`string[]`): plugins to load though `package.json` does not list them.
- `disabled` (`string[]`): plugins never to load, built-ins included.
- `options` (`Record<string, object>`): each plugin's own options, keyed by plugin name. Each plugin
  gets only its own.

```jsonc
// .sous/sous.config.jsonc
{
    "plugins": {
        "load": [
            "sous-plugin-bun"
        ],
        "disabled": [
            "sous-plugin-old-thing"
        ],
        "options": {
            "sous-plugin-claude-code": {
                "model": "opus"
            }
        }
    }
}
```

- When the global sous hands off to a project's installed sous, global plugins are not loaded. When
  there is no project install, the package-manager plugins also look in the global `node_modules`
  next to the global sous.
- In Yarn Plug'n'Play projects, module lookup needs Yarn's own resolver; `plugin-yarn` provides it.

### Where plugins come from

> "recipes can provide sous plugins."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. Plugins come from npm, or from recipes.
2. `plugin-recipes` downloads what subscribed recipes need during config building, and the loop
   carries on. Downloads are cached, so later passes find them already there (S2).
3. Nothing inside a repository runs until the repository is trusted:

    > "The rule is: we never execute anything inside of a repo until we trust it."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-25)

4. Anything in a recipe that runs (plugins, helper scripts, hooks) is one self-contained bundle:

    > "Anything in a recipe must be a bundle because Sous will never manage a `npm install`; this
    > applies to helper scripts of all kinds, and there are many kinds."
    >
    >   -- **Luke Chavers** in an agent session (2026-10-25)

```yaml
# sous.recipe.yaml
plugin:
    bundle: plugin/index.js
    types: plugin/index.d.ts      # optional
```

### Dependencies and order

> "I think its also appropriate for plugins to declare dependency on other plugins, with a version,
> and also be able to say "my config processing should always come after x plugin" (or before)."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

1. `dependsOn` names the plugins a plugin needs, with version ranges. Sous stops before any intent
   runs when a needed plugin is missing, or loaded at a version outside the range, and names it.
2. `before` and `after` sit on contributors (S2). A plugin may declare them too, as the default for
   every contributor it adds. They only affect speed.
3. A plugin may bring in other plugins as its own dependencies. Users can set their options or
   disable them by name, like any other plugin.

### Recipes that require npm plugins

A recipe can require plugins from npm, each with a version range:

```yaml
# sous.recipe.yaml
requires:
    plugins:
        sous-plugin-claude-code: "^1.0.0"
```

- `sous subscription add` refuses a recipe whose required plugin is missing or outside the range. Run
  interactively, it offers to install the plugin through the project's package-manager plugin;
  `--install-plugins` does the same without a prompt (L4).
- A build fails when a subscribed recipe's requirement is broken, for example after the plugin was
  removed. The message names the plugin and the command that installs it.

## Built-in Plugins

Built in, and loaded unless the config disables them: the plugins S6 lists, which include the
package managers (npm, pnpm, Yarn), the repository hosts (GitHub, GitLab, local), the CLI, the MCP
server, and Claude Code. The default sous experience assumes Claude Code. Codex, and every other
agent tool, are separately installed plugins.

## Visibility

Every contributor, intent, listener, service, wrapper, replacement, entity and plugin option is
recorded with the plugin that made it, and the user can see them all (G4):

```text
$ sous plugins show
sous-plugin-remote-config
  replaces           git.runner
plugin-claude-code (built in)
  entities           harness: claude    skill-target: claude-code    memory-target: claude-code
  listeners          build.after
plugin-gitlab (built in)
  entities           repository-host: gitlab
sous-plugin-mcp-extras (loaded by sous-plugin-claude-code)
  options            { "port": 7801 }
```

## Timing and Budgets

Timing is a core mechanism (L5).

- Every core stage, every contributor run, every intent and every service or entity method call
  from another plugin is timed, and each has a budget.
- Sous warns when anything goes over budget, core stages included, since the user's own setup (a
  very complex config, for example) can slow them.
- Budgets can be changed under the `budgets` config key. A budget set to `false` turns its warning
  off.
- Warnings go to stderr, so they never mix with `--json` output.
- `--timings` on any command prints every timing.
- Timing must cost almost nothing when nothing is over budget.

```text
$ sous build
Warning: building the config took 840ms (budget 200ms).
  conf.d/530-team.js took 610ms of that.
  See every timing with: sous build --timings
```

- `sous --help` and shell completion take under 150ms (ruled 2026-10-25).
- Every other budget is set from measurements taken during the refactor, and kept as a default in
  core. A test fails when a stage or call has no budget (ruled 2026-10-25). For comparison, on
  2026-10-18 the current sous took 0.22s for `--version`, 1.05s for `--help` and 1.19s for
  `config show`, mostly from compiling TypeScript through tsx on every run and from importing all 36
  command modules for `--help`.
- Plugin discovery gets no cache until the budgets show a need for one.

## Open Questions

None. (The name `plugin-recipes` is an agent decision the user may overrule.)

## Changes

None yet.
