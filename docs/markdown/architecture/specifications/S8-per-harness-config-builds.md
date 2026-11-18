# S8: One Config Build per Harness

**Status:** Accepted on 2026-11-16 (Luke's design, with the agent's recommendations: "I accept your
recommendations"); built on 2026-11-18. From now on, a change to this specification is recorded
under "Changes".

**Serves:** G3 (versatility, always), G4 (predictable and observable), G8 (every core feature works
without any particular agent tool), G9 (very fast), G10 (config as desired state).

**Trades:** G9 against G3. Each registered harness costs one more full config build on every command
that builds the config. Luke accepted that cost for the versatility it buys, and limited it with the
test in "What Needs a Variant": the harness is the only thing that gets its own builds.

**Related:** S1 (the engine), S2 (building the config), S5 (config expressions).

**Shaped by:** L5 (every stage timed, with a budget), L7 (choose the more versatile approach), L8
(declarations as config).

## What This Specifies

"Harness" is the word Sous's code uses for a coding tool, such as Claude Code or Codex. A plugin
that knows a tool registers one `harness` entity for it (`sous.entities.add("harness", { id, ... })`).

Before this specification, nothing a recipe author or a project writes could read the harness:
config expressions read `host.platform`, environment variables, config variables and recipe answers,
and the only per-tool branching was code inside plugins. Luke's statement of the problem:

> "Sous has no internal understanding of the tool it is rendering for and cannot provide
> conditionals, anywhere, on the basis of tool/harness."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

This specification makes the harness an input of the config build, like `host.platform`, by building
the config once per harness, and says how the builds become the one config that intents read.

## The Builds

1. The default config build runs with no harness. In it, `harness.id` is the empty string `""`,
   never `undefined`: an unknown variable is an error once the config settles (S5), and a condition
   on the harness must never be one.
2. Every `harness` entity registered in any build starts one more full config build, with that
   harness as an input. Each is a complete build (S2): every stage, every pass, its own plugin
   activation, its own validation.
3. A harness's build may register another harness, which starts one more build. No harness is built
   twice, so the process ends when no build registers a new harness. Sous never needs the list of
   harnesses in advance; the build with no harness does the discovering.
4. Config building is complete when the build with no harness and every harness build have
   finished. Harness builds run side by side (`Promise.all` in one process: contributors that wait on
   files or the network overlap; plain computation does not).
5. When no harness is registered, only the build with no harness runs and nothing is merged.
6. A harness build that fails fails the whole config build; its error names the harness. Intents
   that tolerate a broken config get the build with no harness, which succeeded.
7. `config.built` fires once, for the merged config, after every build has finished.

Luke's wording for the trigger and the end:

> "When anything adds a new and unique harness, a config build for that harness also kicks off, in
> parallel"
>
> "once the `no-harness` build and all pending harness builds complete"
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

A harness build starts once the build that registered its harness has settled, not while that build
is still running: a harness registered in pass 1 can disappear by pass 3 (its plugin is switched
off), and a build started for it would be wasted.

### Reading the harness

- Config expressions read `harness.id` (S5):

    ```jsonc
    {
        "compilation": {
            "includeSourceComments": { "$if": "harness.id == 'codex'" }
        }
    }
    ```

- Contributors read `config.harness.id` on the builder (`ConfigBuilder.harness`, a `BuildHarness`).
  The harness never changes within a build, so reading it is not recorded as a read.
- A `.js` or `.ts` config file's `configure(config)` reads `config.harness.id` the same way.
- `harness` is a built-in name in expressions, like `host` and `env`: it is never looked up as a
  variable, so a `_vars.harness` cannot be read under that name.

## What Needs a Variant

> "something needs a variant only when one build, on one machine, must hold more than one value of
> it at the same time AND we expect that value to be available in config conditionals."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

By this test the harness is the only thing that gets its own builds:

- Values only templates need are set per output, with the output's `_vars`.
- Personal settings override the project's and end as one value.
- "Is this output going to the home directory" and "which sub-project is this" are facts about an
  output's path, handled per output.
- The operating system, environment variables, the git branch and recipe answers have one value per
  run.

Luke raised the test because of cost: "adding additional 'variants' could rapidly increase Sous'
compute and potentially its processing time during config building". A project realistically has
one to three harnesses; the count would only multiply if a second kind of variant were added.

## The Merge

Every intent, and the compiler, reads one config: the merge of the builds. The rule is one rule, not
one per list:

**A list entry that belongs to one harness is taken from that harness's build. Everything else stays
as the build with no harness has it.**

1. The merged config starts as the build with no harness.
2. The rule applies to the lists named by `harness-list` entities. Core registers three:

    | id | path |
    |---|---|
    | `compilation.outputs` | `compilation.targets[].outputs` |
    | `editor.edits` | `editor.edits` |
    | `recipes.contents` | `recipes.contents` |

    `[]` means "every item of this array". A plugin adds a list of its own the same way:
    `sous.entities.add("harness-list", { id: "hooks", path: "hooks.list" })`.
3. In a harness's build, an entry of such a list belongs to that harness when:
    - it is marked with it (`harness: "codex"`); or
    - it is not marked, and the build with no harness does not hold an equal entry (it exists only
      because of the harness, through a condition on `harness.id`). Copies are counted, so a second
      copy of an entry the build with no harness holds once belongs to the harness.

    Entries marked with another harness are ignored: they come from their own harness's build.
4. In the merged list, the entries of the build with no harness stay in place, except those marked
   with a harness that had a build. The first of those is replaced by every entry that belongs to
   that harness; the rest are dropped. A harness whose entries replace nothing has them added at the
   end, harnesses in id order. An entry of the second kind in point 3 is added marked with its
   harness when it is an object.
5. An entry marked with a harness that had no build of its own (no plugin registered it) stays as
   the build with no harness has it.
6. For a path through an array (`compilation.targets[]`), each target of the build with no harness
   is matched in a harness's build by its `id`, else by its place. A target only a harness's build
   holds is not carried, since targets are not a `harness-list`.
7. Variables are never merged. An output taken from a harness's build brings the `_vars` written on
   it, where they already win over every other level. The root, `compilation` and target `_vars` of
   the merged config are the build with no harness's.

Outputs are marked by the contributors that generate them, which know the harness from the skills
directory or instructions file they write for:

```js
{
    entryPoint: ".../skills/about-the-harness/SKILL.tpl.md",
    outputs: [
        {
            destinationDir: "${projectRoot}/.claude/skills",
            harness: "claude-code",
            _vars: { toolName: "Claude Code" },
        },
        {
            destinationDir: "${projectRoot}/.codex/skills",
            harness: "codex",
            _vars: { toolName: "Codex" },
        },
    ],
}
```

The result is a plain union: nothing is written twice and nothing conflicts.

## The Weak Case, and Why Every Harness's Config Stays Reachable

A harness condition on something that is not an entry of a `harness-list` is computed in that
harness's build and then left behind by the merge:

```jsonc
{
    "compilation": {
        "includeSourceComments": { "$if": "harness.id == 'codex'" }
    }
}
```

The setting is `true` in the `codex` build and `false` in the merged config, which the compiler
reads. So the per-harness configs are not thrown away: code that acts for one harness asks for that
harness's full config.

```ts
const codex = ctx.config.forHarness("codex");                     // BuiltConfig | undefined
const comments = codex?.get<boolean>("compilation.includeSourceComments");
```

> "By defining everything that can vary based on harness, we potentially close doors to future
> config dynamics based on harness and some harnesses are _very_ different than Codex and Claude. As
> you know, I always favor versatility."
>
>   -- **Luke Chavers** in an agent session (2026-11-16)

The build order Luke accepted: the per-harness builds and the merge first. Reading an output's
settings from its harness's build is added to the compiler, and to `sous launch <harness>`, when the
first real need appears.

## The API

- `ConfigBuilder.harness: BuildHarness` (`{ id: string }`): the harness of the build; `""` with none.
- `BuiltConfig.harness: string`: `""` for the merged config and the build with no harness; the
  harness's id for a harness's build.
- `BuiltConfig.harnesses: readonly string[]`: every harness that had a build, sorted; `[]` with none.
- `BuiltConfig.forHarness(id: string): BuiltConfig | undefined`: that harness's full config;
  `forHarness("")` gives the build with no harness, before the merge.
- `ConfigLayer.build` and `Contribution.build` (`string`): the build a change was made in.
- The entity kind `harness-list` (`{ id, path, description? }`), defined by core.
- The entity kind `harness` is defined by `@sous-io/plugin-harnesses`; core only reads its ids.

## Seeing It

- `sous config show --harness <id>` and `sous config get <path> --harness <id>` print one harness's
  own build instead of the merged config. A harness with no build is an error naming those built.
- `--layers` names the build of each change once any change came from a harness's build
  (`no harness`, `harness codex`). On the merged config, the changes each harness build made to a
  `harness-list` are listed after the build with no harness's, with the indices of that harness's
  own build. A project with no harness sees what it always did.
- `--timings` (L5) shows:
    - `config.build:config`: everything, from the first build to the merge;
    - `config.harness:<id>`: one harness's build (budget 200 ms);
    - `config.stage:<id>/<stage>` and `config.pass:<id>/<stage>.<pass>` inside it;
    - `config.merge:config`: the merge (budget 20 ms).

    Contributor timings are shared between builds (`contributor:<id>` counts every build's runs), so
    a budget set for a contributor applies in every build.

Measured once, on this repository with one harness (`claude`), on 2026-11-18: the whole config build
took 436 ms, of which the harness build took 117 ms and the merge 1.6 ms.

## The Alternative Set Aside: Run Each Intent Once per Harness

Luke listed three ways for intents to act on several configs: each intent names the build it wants;
each intent runs once per build; or the builds are merged ("which seems like the best bet, but that
would also merge variable values"). The merge was chosen, with variables left unmerged.

- **Each intent names its build:** most intents have nothing to do with a harness (`config get`,
  subscription and repository commands), and `build` wants every build at once.
- **Each intent runs once per build:** pinned, not rejected. Luke and the agent agreed it could be
  made to work with more decisions, and set it aside. Its pieces: the contributors that generate
  outputs add only the build's harness's outputs; a project may put harness conditions on its own
  targets; something in the compiler avoids writing a file twice, "giving preference to the
  `no-harness` version", and on a real conflict "it makes sense that the `harness` variable becomes
  undefined and maybe emits a warning". It would still need a rule for what is not tied to a harness
  (for example, only the run with no harness handles it). The first two pieces work with the merge
  too.

Both approaches cost the same where it matters: both build one full config per harness. They differ
only in what happens after the builds finish.

## Open Questions

- The accepted design also says Sous reports values that differ in a harness's build but that
  nothing read from that build, since such a condition silently has no effect. Not built yet.
- A skills directory a person sets by hand (`recipes.skills.outputs`) has no harness; it may need a
  way to be labelled with one.
- No budget has been measured for projects with several harnesses; the 200 ms per harness build is a
  first guess, like every other budget.

## Changes

### 2026-11-18: Built

First version, written when the design was built. Choices the agent made where the design left
them open, approved by nobody yet:

- A harness build starts when the build that registered its harness has settled, not mid-build.
- The lists the merge applies to are `harness-list` entities, so a plugin can add one; core
  registers the three the design names.
- Entries a harness's build holds that the build with no harness does not are found by deep
  equality, counting copies.
- A target is matched between builds by its `id`, else its place.
