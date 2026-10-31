# @sous-io/plugin-expressions

Lets config values be written as expressions, such as a Liquid template, and works out their values while the config is built.

It adds no commands. Other plugins add languages as `expression-language` entities.

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-expressions/types";

const evaluator = ctx.services.get("expressions.evaluator");
const languages = evaluator.languages();
```

## Where things are

- `src/evaluator.ts`: evaluates a config layer.
- `src/parse.ts`: recognizes expression values.
- `src/liquid-language.ts`: the built-in Liquid language.
- `src/index.ts`: registration.

## Testing

```bash
pnpm --filter @sous-io/plugin-expressions test
```
