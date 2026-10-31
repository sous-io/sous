# @sous-io/plugin-authoring

Lets the maintainer of a recipe repository release it, propose changes to it, contribute to someone else's, and start a new one.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous repo release` | bumps the version of changed recipes, regenerates the index, commits and tags (`--check` only validates) |
| `sous repo submit` | pushes the branch and opens or updates a proposal through the repository host |
| `sous repo contribute` | starts a contribution on a fresh branch; `--finish` submits it and goes back to pinned versions |
| `sous repo init` | creates a new recipe repository in a directory |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-authoring/types";

await ctx.run("repo.release", { check: true });
```

## Where things are

- `src/index.ts`: registers the four intents; each handler loads only when it runs.
- `src/release/`, `src/submit/`, `src/contribute/`, `src/scaffold/`: one folder per intent.
- `src/schemas.ts`: the inputs the commands accept.

## Testing

```bash
pnpm --filter @sous-io/plugin-authoring test
```
