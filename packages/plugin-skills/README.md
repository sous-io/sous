# @sous-io/plugin-skills

Chooses which recipe skills reach the places agents read them from, such as `.claude/skills`.

It adds no commands.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-skills/types";

const sources = ctx.services.get("skills.sources").list();
```

## Where things are

- `src/sources.ts`: where skills come from.
- `src/targets.ts`: the compilation targets for skill folders.
- `src/skill-target.ts`: the `skill-target` entity.
- `src/settings.ts`: the `recipes.skills` config key.

## Testing

```bash
pnpm --filter @sous-io/plugin-skills test
```
