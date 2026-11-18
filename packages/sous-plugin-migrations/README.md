# @sous-io/sous-plugin-migrations

Sous's own migrations: the steps that bring a project's files in line with a newer version of sous.

- A plugin adds one with `sous.migrations.add({ version, order, up })`.
- The project's lockfile records the version of sous whose migrations it last ran (`migratedVersion`); every
  migration of a later version is pending. A new project's first lockfile records the version that created it.
- `sous doctor` and `sous upgrade` run the pending ones (the hidden command `sous migrations run`).
- Every other command prints one line when some are pending, and carries on.

## Adding a migration

```ts
sous.migrations.add({
    version: "1.1.0",
    order: 500,
    description: "Move the memories file out of the project's CLAUDE.md",
    questions: [
        {
            id: "memories.location",
            message: "Where should the memories file be written?",
            choices: [
                { value: "move", label: "To .claude/rules/SOUS-MEMORIES.md" },
                { value: "keep", label: "To CLAUDE.md, as before" },
            ],
            default: "move",
            answered: (ctx) => (ctx.config.get("some.setting") === undefined ? undefined : "keep"),
        },
    ],
    async up(ctx, { answers }) {
        return { summary: `Chose ${answers["memories.location"]}.` };
    },
});
```

The plugin registers after this one (it is a built-in, loaded early). Migrations run lowest version first, then by
`order` (default 500, higher later), then in the order they were added. There is no `down`.

Every question is asked before anything runs. Without a terminal, `--yes` takes each default and
`--answer <id>=<value>` answers one; with neither, nothing runs and the command lists each question and the
`--answer` for it. A question whose `answered` returns a value is not asked.

## Tests

```bash
corepack pnpm vitest run packages/sous-plugin-migrations
```
