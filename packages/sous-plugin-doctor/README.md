# @sous-io/sous-plugin-doctor

`sous doctor`: runs every check a plugin adds, reports what it found, and offers to fix each
problem, asking before each fix.

| Command | What it does |
|---|---|
| `sous doctor` | runs every check, and fixes what it can after asking |
| `sous doctor --dry-run` | reports, and changes nothing |
| `sous doctor --yes` | applies every fix without asking |
| `sous doctor --only outputs` | runs one check |

It ends with exit code 1 when a problem remains.

## Adding a check

```ts
import { DOCTOR_CHECK_ORDER } from "@sous-io/sous-plugin-doctor";

sous.entities.add("doctor-check", {
    id: "git-hooks",
    order: DOCTOR_CHECK_ORDER.gitHooks,
    description: "The git hooks this project was set up with are installed",
    check: (ctx, run) =>
        hooksInstalled(ctx)
            ? { status: "ok" }
            : { status: "problem", summary: "The git hooks are not installed.", fix: "Install the git hooks" },
    fix: async (ctx) => ({ summary: await installHooks(ctx) }),
});
```

The plugin adding a check depends on this one (`dependsOn: { "@sous-io/sous-plugin-doctor": "^1.0.0" }`), so
the `doctor-check` kind exists when it registers.

## Layout

- `src/types.ts`: the contract: `DoctorCheckEntity`, `DoctorRun`, `DOCTOR_CHECK_ORDER`.
- `src/doctor.ts`: the `doctor` intent.
- `src/checks.ts`: the built-in checks: the config loads, the lockfile agrees with the subscriptions, required
  recipe variables have answers, the files sous wrote are present and unchanged.

## Tests

```bash
corepack pnpm vitest run packages/sous-plugin-doctor
```
