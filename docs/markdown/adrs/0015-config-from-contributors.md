# ADR 0015: The config is built by contributors, from primitive patches

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The details are in
[Building the Config](../architecture/specifications/S2-config-building.md). Where this record and
that file disagree, it wins. It replaces the way config layers are found and merged before 1.0,
described on [Layers and merging](../config-layers.md).

## Context

Before 1.0, working out the config is spread over several places: the files are found in one,
merged in a separate child process started on every run, recipe layers and built-in entries are
added before and after the merge, variables are resolved later by each caller, and the managed
subscriptions file is read a second time, which lets it override a later layer.

Plugins also needed a way to change the config. An earlier plan gave them a separate bootstrap
config, read before everything else.

The maintainer ruled how a plugin's change to the config is recorded:

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

- **One loop builds the config, in the main process.** Every source of config is a
  **contributor**, a piece of code that adds to the config: each config file, the recipe config
  layers, the built-in entries, the environment and any plugin. There is no child process; `.js`
  and `.ts` config files are imported.
- **A contributor never edits the config directly.** It works through a builder that records each
  change as its **patch** and records each value it reads. It sees the config made from every other
  contributor's latest patch, without its own, so running it twice never applies its change twice.
- **A contributor runs again only when something it read has changed.** The loop ends when nothing
  read has changed and no new contributor or plugin appeared. A loop that does not settle within a
  limit is an error naming the values that kept changing.
- **The user's files win.** A config file reads the whole config, so it runs again after any change
  and its patch lands on top. Among themselves the user's files keep their order from before 1.0.
- **Plugins load inside the loop.** After each pass the engine loads any new plugin the `plugins`
  key lists. There is no bootstrap config.
- **Every change is made of a few primitive operations** (set, delete or rename a key; set, insert
  or remove an array item). Every other builder operation is a helper that produces them. They
  serialize to JSON, so a set of changes can be saved, sent, previewed and applied later, and users
  may write them by hand in patch files.
- **There is no `setDefault`.** A plugin's defaults for its own keys live in the schema it
  registers. A plugin suggesting a value for another plugin's key just sets it, and the user's files
  still win.
- **A contributor may ask to run before or after another, or in a later stage**, which is rarely
  needed.
- **Config expressions** ([ADR 0020](0020-config-expressions.md)) are evaluated inside each file's
  contributor, so a variable an expression reads is recorded like any other read.
- **Sous always reads the built config.** No code treats one config file as special. The files sous
  manages are edited key by key by the commands that change them, never by contributors.
- **One package edits documents in place**, keeping comments, key order and formatting. The config
  builder and sous's edits to its managed files both use it.

## Consequences

- A later `conf.d` file can switch off a subscription that the managed subscriptions file lists.
  Before 1.0 it could not.
- `sous config show --layers` and `sous config get --layers` show each contributor's change to a
  value, in order.
- A `.js` config file that changes in watch mode is imported again under a new URL, since Node cannot
  unload a module; each reload leaks a little memory.
- A config whose contributors read nothing that later changes is built in one pass.
