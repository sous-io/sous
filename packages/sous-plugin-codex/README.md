# @sous-io/sous-plugin-codex

Teaches sous about Codex: how to start it, where its memories file goes (`AGENTS.override.md`), and where
its skills go (`.agents/skills`).

It is built in but does nothing until a project turns it on, by writing this plugin's options (even `{}`)
or `tools.codex` in its config. It adds no commands. `sous launch codex` works because of it.

Nothing here has been run against Codex itself; see `docs/markdown/codex.md` for what is untested.

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-codex/types";

const harness = ctx.entities.get("harness", "codex");
```

## Where things are

- `src/harness.ts`: the Codex harness (`launch` only).
- `src/targets.ts`: the contributor that adds the harness, the skill and memory targets and the
  `.gitignore` line, when Codex is on.

## Testing

```bash
corepack pnpm vitest run packages/sous-plugin-codex
```
