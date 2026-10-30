# @sous-io/repository-hosts

Code the repository host plugins (GitHub, GitLab, local) share: addresses, token lookup, reading a repository over HTTP or git, and driving `gh` or `glab`.

It is a library, not a plugin: import it directly, not through `ctx`. It adds no commands.

## Using it from another plugin

```ts
import { splitRepoUrl } from "@sous-io/repository-hosts";

const parts = splitRepoUrl("https://github.com/sous-io/sous-recipes");
```

## Where things are

- `src/urls.ts`: repository addresses.
- `src/token-sources.ts`: finding a token.
- `src/http-strategy.ts`, `src/git-strategy.ts`: the two ways to read a repository.
- `src/cli.ts`: running `gh` and `glab`.
- `src/testing.ts`: stand-ins for tests.

## Testing

```bash
pnpm --filter @sous-io/repository-hosts test
```
