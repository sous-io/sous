# @sous-io/sous-plugin-gitlab

Lets sous read recipe repositories hosted on GitLab, sign in with a token, and propose changes as merge requests.

It adds no commands. Its options (`plugins.options."@sous-io/sous-plugin-gitlab"`) are described in `src/types.ts`.

## Using it from another plugin

```ts
import type {} from "@sous-io/sous-plugin-gitlab/types";

const gitlab = ctx.entities.get("repository-host", "gitlab");
```

## Where things are

- `src/host.ts`: the repository host: its URLs, API addresses and read strategies.
- `src/instance.ts`: where a self-managed instance is installed (a port, a sub-path), asked of the server once and remembered.
- `src/proposals.ts`: opening and following merge requests.
- `src/ci.ts`: the release pipeline a new repository gets.
- `src/glab.ts`: calling the `glab` tool.

## Testing

```bash
pnpm --filter @sous-io/sous-plugin-gitlab test
```
