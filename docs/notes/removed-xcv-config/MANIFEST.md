# Removed: `xcv config*` / `xcv configure` and the profile machinery

Snapshot taken before deletion so the code can be revived on a `preserve/xcv-config`
branch if the profile idea is ever wanted back.

Removed as part of the walk-up `.sous/` discovery refactor. `.sous/` discovery plus the
`--config <path>` flag replace the whole profile chain, so nothing here has a caller
anymore.

## Files (paths relative to the repo root)

| Preserved copy | Original path | What it was |
|---|---|---|
| `src/commands/configure.ts` | `src/commands/configure.ts` | `xcv configure` interactive wizard. Prompted for a profile name and a `defaultConfigPath`, then wrote both to `~/.sous/settings/`. Lines 32-42 held a dead branch: the multi-profile and single-profile arms were byte-identical. |
| `src/commands/config/get.ts` | `src/commands/config/get.ts` | `xcv config get <key>`. Read `profile` from `~/.sous/settings/sous.config.json` or any key off the active profile file. |
| `src/commands/config/set.ts` | `src/commands/config/set.ts` | `xcv config set <key> <value>`. Wrote `profile` or a profile key (in practice only ever `defaultConfigPath`). |
| `src/commands/config/show.ts` | `src/commands/config/show.ts` | `xcv config show`. Printed the active profile name and the profile JSON. |
| `src/lib/user-settings.ts` | `src/lib/user-settings.ts` | The whole `~/.sous/settings` layer: `SOUS_HOME`, `SETTINGS_DIR`, `PROFILES_DIR`, `SOUS_CONFIG_PATH`, `ensureSousHome`, `loadSousConfig`, `saveSousConfig`, `getProfilePath`, `loadProfile`, `saveProfile`, and the `SousConfig` / `ProfileConfig` types. |
| `src/base-command.ts.orig` | `src/base-command.ts` | The pre-refactor `BaseCommand` (kept for reference only; the file itself still exists, rewritten). Its `init()` called `ensureSousHome()`, `loadSousConfig()`, `loadProfile()`, then `loadSettings(profile.defaultConfigPath)`. It also exposed `this.sousConfig`, `this.profile`, and `this.profileName`, which `xcv config*` read. |

## Why it went

- Two files to say one thing. `~/.sous/settings/sous.config.json` held a single field
  (`profile`), and `~/.sous/settings/profiles/<name>.profile.json` held a single field
  (`defaultConfigPath`). Exactly one profile ever existed in practice.
- The path had to be absolute, with no `~` expansion and no relative paths, and the only
  way to set it was `xcv config set defaultConfigPath /abs/path`. Nothing about that is
  discoverable on a fresh machine.
- Config now lives with the project it configures: sous walks up from `cwd` looking for a
  `.sous/` directory that holds `sous.config.js` / `.mjs` / `.json`, and `--config <path>`
  overrides that. Machine-specific values go in `.sous/.env.local` and reach the config
  through the existing `_env` block.
- No tests covered any of this code, so nothing was deleted from the test suite for it.

## If you revive it

`BaseCommand` no longer has `sousConfig`, `profile`, or `profileName`, and no longer has a
`requiresSettings` escape hatch (discovery is required by every command). A revived
`xcv config*` would need to reintroduce those, or read `~/.sous/settings` directly without
touching `BaseCommand`. `ensureSousHome()` also went away with `user-settings.ts` — no
remaining code needs `~/.sous`.
