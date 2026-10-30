# @sous-io/plugin-github

Lets sous read recipe repositories hosted on GitHub, sign in with a token, and propose changes as pull requests.

It adds no commands. Its options (`plugins.options."@sous-io/plugin-github"`) are described in `src/types.ts`.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-github/types";

const github = ctx.entities.get("repository-host", "github");
```

## Where things are

- `src/host.ts`: the repository host.
- `src/proposals.ts`: opening and following pull requests.
- `src/ci.ts`: the release workflow a new repository gets.
- `src/gh.ts`: calling the `gh` tool.

## Testing

```bash
pnpm --filter @sous-io/plugin-github test
```
