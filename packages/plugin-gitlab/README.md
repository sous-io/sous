# @sous-io/plugin-gitlab

Lets sous read recipe repositories hosted on GitLab, sign in with a token, and propose changes as merge requests.

It adds no commands. Its options (`plugins.options."@sous-io/plugin-gitlab"`) are described in `src/types.ts`.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-gitlab/types";

const gitlab = ctx.entities.get("repository-host", "gitlab");
```

## Where things are

- `src/host.ts`: the repository host.
- `src/proposals.ts`: opening and following merge requests.
- `src/ci.ts`: the release pipeline a new repository gets.
- `src/glab.ts`: calling the `glab` tool.

## Testing

```bash
pnpm --filter @sous-io/plugin-gitlab test
```
