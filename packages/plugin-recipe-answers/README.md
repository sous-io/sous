# @sous-io/plugin-recipe-answers

Finds out the values of the variables recipes ask for, from the project's saved answers, the environment and questions to the user.

It adds these commands:

| Command | Does |
| --- | --- |
| `sous vars list [name]` | lists the variables recipes define and their values |
| `sous vars show <name>` | one variable: what it is for and where its value came from |
| `sous vars ask [name]` | asks for answers and saves them |
| `sous vars map` | binds an environment variable to a recipe variable |

## Using it from another plugin

```ts
import type {} from "@sous-io/plugin-recipe-answers/types";

const answers = ctx.services.get("recipe-answers.answers").get();
```

## Where things are

- `src/definitions.ts`: finds the variables recipes define.
- `src/ladder.ts`, `src/answers.ts`: where answers come from, in order.
- `src/ask.ts`: asking the user.
- `src/mappings.ts`: environment variable bindings.
- `src/intents.ts`: the commands. Each returns outputs; `vars.list` declares `{ variables: [...] }`.
- `src/outputs.ts`: the listing, one variable in full and the `vars ask` report, as outputs.

## Testing

```bash
pnpm --filter @sous-io/plugin-recipe-answers test
```
