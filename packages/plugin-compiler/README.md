# @sous-io/plugin-compiler

Turns templates into the output files of a project, and tracks what it wrote so stale files can be removed.

It adds no commands of its own; `sous build` and `sous compile` (from `plugin-build`) call its intents:

| Command | Does |
| --- | --- |
| `compiler.compile`, `compiler.prune` | intents behind `sous build`; most users run those instead |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-compiler/types";

const writer = ctx.services.get("compiler.writer");
await writer.write("docs/notes.md", "# Notes\n", { source: "my-plugin" });
```

## Where things are

- `src/index.ts`: registers services, intents, tags and config keys.
- `src/compiler.ts`: compiles one target.
- `src/writer.ts`, `src/state.ts`: writing outputs and the state file.
- `src/includes.ts`, `src/aliases.ts`: includes and path aliases.

## Testing

```bash
pnpm --filter @sous-io/plugin-compiler test
```
