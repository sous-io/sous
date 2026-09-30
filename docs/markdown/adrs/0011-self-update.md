# ADR 0011: `sous update` updates sous through the package managers

**Status:** Proposed, 2026-09-30.

This record builds on [ADR 0004](0004-project-install-handoff.md), whose hand-off from a global sous to a
project's own install this command has to step around; everything ADR 0004 says still holds. The living answer
is [Updating](../README.md#updating) and the [command reference](../commands.md#sous-update); the process
record is [gh-135](https://github.com/sous-io/sous/issues/135).

## Context

Updating sous meant knowing which package manager installed each copy, remembering that manager's syntax for a
global install and for a dev dependency, and running it once per copy. A machine often holds two copies: a global
one, and a project's pinned devDependency that the global copy hands off to (ADR 0004). A project update also has
to move the `core/sous-skills` pin in `.sous/sous.lock.json`, which only a build does.

The maintainer asked for one command that does all of it:

> "Basically, this tool should just be a shortcut to using those tools."
>
>   -- **Luke Chavers** in an agent session (2026-09-30; recorded in gh-135)

> "this command should do whatever needs to be done to update the project lockfile(s), etc. It should just work."
>
>   -- **Luke Chavers** in an agent session (2026-09-30; recorded in gh-135)

and ruled how it asks:

> "users will need to confirm EACH upgrade (2x for global+project, 2 separate confirm prompts) unless `--yes` is used, which will install all upgrades found."
>
>   -- **Luke Chavers** in an agent session (2026-09-30; recorded in gh-135)

The behavior below follows the design in gh-135's description, quoted where it is relied on. Every detail marked
"(Agent suggestion; the maintainer has not ruled on it.)" was added during implementation, or comes from the
issue's "Technical Notes", which the issue itself labels as agent suggestions.

## Decision

### Which installs are updated

- The project install is the nearest `node_modules/@sous-io/sous` walking up from the working directory, found
  the way the ADR 0004 hand-off finds it, and updated only when the project's `package.json` declares it. The
  global installs are every copy found under a global root, and each is judged on its own version. The issue's
  table:

  > "Outside a project, or in a project without its own install | any | none | the global install only"
  > "In a project with its own install | present | present | both, each confirmed separately"
  >
  >   -- gh-135, "Which installs are updated"

- A Yarn Plug'n'Play project keeps no `node_modules` copy, so when the walk finds none, the project install is
  the nearest `package.json` at or above the working directory that declares the package, with a `.pnp.cjs` in
  its directory or above it. Its manager is Yarn Berry, its version is the one `yarn.lock` (beside `.pnp.cjs`)
  resolves the declared range to, and the plan names `.pnp.cjs` as its location. (Agent suggestion; the
  maintainer has not ruled on it.)
- `--global` and `--project` narrow the run to one side, and exclude each other.
- A global install's manager is found by asking each of npm, pnpm and Yarn classic for its global root
  (`npm root -g`, `pnpm root -g`, `yarn global dir`) and looking for the package there; two managers naming one
  copy, by real path, count once. A manager that is missing or cannot answer is skipped. (Agent suggestion; the
  maintainer has not ruled on it.)
- The project's manager is read from its files. A copy run through `npx`, one managed by Volta, a project whose
  manager sous does not drive (bun, deno) and a copy whose version cannot be compared are reported, with the
  command to run by hand where one is known, and the other installs are still updated.

### Which version is chosen

- **Default:** the newest published version in the install's current major, never a downgrade:

  > "the newest published version in the current major (`>=<current> <<next major>`). A run never downgrades by default"
  >
  >   -- gh-135, "Which version is chosen"

  For a 0.x install the major is 0, so the range ends below 1.0.0, not at the next minor as a caret range would.
  The upper bound is written `<1.0.0-0`, so a prerelease of the next major (`1.0.0-rc.1`, which sorts below
  `1.0.0`) is outside it too; `defaultRange` in `src/lib/self-update/versions.ts`. (Agent suggestion; the
  maintainer has not ruled on it.)
- **`--major`:** the newest published version, whatever its major; still never a downgrade.
- **`--version <version|range|dist-tag>`:** an exact published version, the newest version a range admits, or the
  version a dist-tag points at. This is the one way to downgrade, and the plan and the question say "downgrade".
  `--major` and `--version` exclude each other. An exact version and a dist-tag are taken as named, whatever the
  prerelease setting. (Agent suggestion; the maintainer has not ruled on it.)
- **Prereleases** count as candidates under `--prerelease` (hidden alias `--pre`), which is on by default when
  the installed version is itself a prerelease; `--no-prerelease` switches it off.
- The versions come from the registry's abbreviated package document, from `npm_config_registry` (or
  `NPM_CONFIG_REGISTRY`) when set and the public registry otherwise. The lookup is the point of the command, so a
  registry that cannot be reached fails the run, quoting the reason. (Agent suggestion; the maintainer has not
  ruled on it.)

### Plan everything, then one confirmation per install

- Every plan is worked out before anything is installed, so a `--version` that matches nothing fails before any
  install runs. The plans are then taken one at a time, global installs first: each prints its facts (location,
  package manager, installed version, the version it will install, and for the project whether a build
  follows), then asks its own question, as the maintainer's ruling above requires. `--yes` answers every
  question; `--dry-run` prints every plan with the command it would run and installs nothing. Without a
  terminal and without `--yes`, the run fails with the shared non-interactive error naming `--yes`.
- An install that is already at the chosen version is reported and asked nothing.
- A package manager's failure is printed as the manager reported it, the next install is still offered, and the
  summary names what completed; sous never retries with `sudo`.

### Package-manager-detector writes the commands

- The commands come from [`package-manager-detector`](https://github.com/antfu-collective/package-manager-detector)
  (MIT, no dependencies): `detect` reads a project's manager from its `packageManager` and `devEngines` fields and
  its lockfile, and `resolveCommand` returns the command and arguments for `add` and `global` without running
  them. Sous runs them itself, so every run goes through an injectable executor and a test drives every manager
  with none installed. (Agent suggestion; the maintainer has not ruled on it.)
- On top of the library's table, `src/lib/self-update/managers.ts` adds what an update needs: `-E` for an exact
  pin, `-D` only for a devDependency (so a dependency under `dependencies` stays there), and `-w` (pnpm) or `-W`
  (Yarn classic) at a workspace root. A Yarn project with a `.yarnrc.yml`, or whose `yarn.lock` carries Berry's
  `__metadata` header, is Yarn Berry, which the library would read as classic. (Agent suggestion; the maintainer
  has not ruled on it.)

### `update` skips the hand-off

- `bin/run.js` never hands `sous update` to a project's own copy: updating the copy that was invoked is the job,
  and a project copy may be too old to have the command. The command word is the first argument that does not
  start with `-`, so `sous subscription update` still hands off (`planHandoff` in
  `src/lib/project-install.mjs`). (Agent suggestion; the maintainer has not ruled on it.)

### The new copy builds the project

- After a project update, the newly installed copy's own bin runs `build`, under the running Node and with
  `SOUS_NO_DELEGATE=1` so no other copy takes the build over. That build moves the `core/sous-skills` pin to the
  new version, which is how the maintainer's "update the project lockfile(s)" is met. `--no-build` skips it, as
  on every command that ends in a build.
- Under Yarn Plug'n'Play there is no bin on disk for Node to run, so Yarn runs the dependency's bin itself:
  `yarn run --binaries-only sous build`, with the same `SOUS_NO_DELEGATE=1`. Sous runs there only from a copy
  Yarn has unpacked (`dependenciesMeta` with `unplugged: true`); a failed build says so. (Agent suggestion; the
  maintainer has not ruled on it.)
- The build runs in the directory of the config this run found, when that lies inside the updated project, and
  otherwise in the project root when its `.sous/` holds a primary config; a project with neither is not built.
  (Agent suggestion; the maintainer has not ruled on it.)

### A config this copy cannot load does not stop the update

- A project whose config this copy rejects (one written for a newer sous, or a broken one) would otherwise fail
  before `update` runs, although installing a newer copy may be exactly the fix. `update` sets the `BaseCommand`
  static `toleratesConfigErrors`: a config that cannot be located or loaded becomes one warning naming the
  config and quoting the error, and the run carries on with no config adopted and its env files taken back out
  of the environment. No other command sets it. (Agent suggestion; the maintainer has not ruled on it.)
- A config that was found but not loaded still decides where the build runs, exactly as a loaded one would, and
  a project root holding several primary configs still counts as holding one; the new copy's build is where any
  real problem is then reported. (Agent suggestion; the maintainer has not ruled on it.)

## Consequences

- One command updates every copy sous can find, with one question per copy, and a project update leaves
  `package.json`, the package manager's lockfile and `.sous/sous.lock.json` at the new version.
- A project copy too old to have `update` does not matter, because the invoked copy runs it.
- Copies sous cannot drive (npx, Volta, bun, deno, a source checkout) are named with a command to run by hand,
  rather than updated.
- npm and pnpm are the managers that must work; a Yarn problem may be deferred. The maintainer ruled:

  > "as long as pnpm and npm are working, we can punt anything related to yarn that is giving us trouble."
  >
  >   -- **Luke Chavers** in an agent session (2026-09-30; recorded in gh-135)

  Sous itself cannot run from Yarn's zip cache under Plug'n'Play, so there the post-update build succeeds only
  from an unplugged copy; that is tracked in [gh-137](https://github.com/sous-io/sous/issues/137) (sous runs in
  a Yarn Plug'n'Play project without unplugging).
- On Windows a global install may hold the running shim open while it is replaced. gh-135's notes mention it,
  and nothing in this decision addresses it.
