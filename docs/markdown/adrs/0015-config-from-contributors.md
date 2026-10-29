# ADR 0015: The config is built by contributors, from primitive patches

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S2: Building the Config](../architecture/specifications/S2-config-building.md), with config
expressions in [S5: Config Expressions](../architecture/specifications/S5-config-expressions.md).
Where this record and those files disagree, they win. It replaces how config layers are discovered
and merged before 1.0, described on [Layers and merging](../config-layers.md).

## Context

Before 1.0, config resolution is spread over six places: discovery in `BaseCommand.init` and
`config-discovery.ts`; the merge in a separate child process, `config-kernel.mjs`, started with
`spawnSync` on every load (once under plain Node, then again under tsx); recipe config layers read
and filtered before the merge; built-in entries added after it; variables resolved later, once per
caller; and a second read of `conf.d/510-subscriptions.jsonc` that let the managed file override a
later layer. Plugins needed a way to change the config too, and an earlier plan gave them a
separate bootstrap config read before everything else.

The maintainer ruled how a contributor's change is recorded:

> "I think config contributors should basically return a "patch" to the config, not the modified
> config itself. If a contributor comes up in the loop again, it should be provided the config
> _without its previous modifications_, but it may have access to its previous patches, if it needs
> them. I'm trying to make it so that each contributor does not need to manage idempotency, itself."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

and that the bootstrap config should go:

> "a low-key goal of mine is to eliminate the need for the "boostrap config" and having the
> "discovery plugin" separate."
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

## Decision

- **One loop builds the config, in-process.** Every source of config is a contributor: the
  `sous.config.*` file (`plugin-config-files`), each `conf.d` file (`plugin-confd`, one contributor
  per file), recipe config layers, the built-in entries, the environment, and any plugin. The config
  kernel child process goes away; `.json`, `.jsonc` and `.yaml` files are parsed, `.js` and `.ts`
  files are imported in the main process.
- **A contributor never edits the config.** It is given a builder; every change it makes is recorded
  as its patch, and every read is recorded too. It sees the config made from every other
  contributor's latest patch, without its own, so it never has to make itself idempotent.
- **A contributor re-runs only when something it read changed**, and the loop ends when nothing
  anyone read has changed and no new contributor or plugin appeared. Going over the pass limit is an
  error naming the values that kept changing.
- **The user's files win** because they monitor the whole config and re-run after any change, so
  their patches land on top. Among themselves they keep the old order: `sous.config.*`, then the
  `conf.d` files in file order.
- **Plugins load inside the loop.** The `plugins` key is ordinary config; after each pass the engine
  loads what it lists. There is no bootstrap section.
- **Every change is a primitive patch**: `setKey`, `deleteKey`, `renameKey`, `setIndex`,
  `insertAt`, `removeIndex`. Every other builder operation (`appendValue`, `removeWhere`, a merge) is
  a helper made of them. Patches serialize to JSON, so a set of changes can be saved, sent, previewed
  and applied later. Users may write raw patches in `.patch.json` and `.patch.jsonl` files.
- **No `setDefault`.** A plugin's defaults for its own keys live in the schema it registers for
  them; a plugin suggesting a value for another plugin's key uses an ordinary set, and the user's
  files still win.
- **Contributors may declare `before`, `after` and a `stage`** (a number, default `0`), for speed and,
  rarely, to run after everything else.
- **Config expressions** (`$if`, `$elseif`, `$else`, `$expr`) are evaluated inside each file's
  contributor, so a variable they read is a recorded read like any other.
- **Sous always reads the built config.** No code treats one config file as special; managed files
  are edited key by key by intents, never by contributors.
- **One package edits documents surgically** (`documents`), keeping comments, key order and
  formatting. The config builder is built on it, and so are sous's edits to its managed `conf.d`
  files.

## Consequences

- A later `conf.d` file can switch off a subscription that `510-subscriptions.jsonc` lists, which
  it could not before 1.0.
- `sous config show --layers` and `sous config get --layers` show each contributor's change to a
  value, in order, with the helper operations and the primitive patches they made.
- A `.js` config file is imported, not run in a child process; when it changes on disk in watch
  mode it is imported again under a new URL, a small leak per reload.
- A config whose contributors read nothing that later changes settles in one pass.
