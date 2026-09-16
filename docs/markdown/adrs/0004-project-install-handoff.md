# ADR 0004: A global sous defers to the project's install

**Status:** Accepted, 2026-09-15.

This record stands on its own; it amends nothing in [ADR 0001](0001-repositories.md),
[ADR 0002](0002-recipe-answers-in-templates.md) or [ADR 0003](0003-project-init.md), and
everything they say still holds. The living answer to "how does it work right now?" is
[Installing](../README.md#installing); the process record is
[gh-10](https://github.com/sous-io/sous/issues/10).

## Context

Sous installs globally, as a project dependency, or both, and until now the two installs did
not coordinate: whichever `sous` won on the path ran its own code. For most tools that is a
nuisance. For sous it rewrites tracked files. The implicit `core` subscription asks for exactly
the running version and the lockfile is committed, so a global 0.3.0 run inside a project pinned
to 0.2.4 re-locked `core/sous-skills`, rewrote every core skill, and left the next teammate on
0.2.4 to flip it all back. `sousVersion` and `sousRootPath` in rendered output churned the same
way. Which shell someone typed in decided what a build produced.

## Decision

### The project's dependency is the decision

- A project that installs `@sous-io/sous` has pinned the version its templates and its lockfile
  were written against, and that copy does the work whatever the user typed. The global install
  is a launcher.
- No version comparison decides who wins and nothing prompts. Choosing "the newer one" would
  reintroduce the churn from the other side, and a question on every command would be a tax on
  the common case.
- The lookup walks up from the working directory for `node_modules/@sous-io/sous`, the way Node
  resolves a package, so a copy hoisted to a monorepo root is found from any package inside it.
  It starts from the working directory and not from the discovered `.sous/`, because config
  discovery lives behind tsx and the whole point is to load none of the invoked copy's code.

### One process, not a child

- The hand-off is an `import()` of the project copy's own bin, in the same process, before tsx
  is registered. A child process was rejected: it costs a second Node startup on every command,
  needs signal and TTY forwarding, and needs a Windows shim. ESM resolves each file's imports
  from its own location, so the two installs never share a module.
- The copy's bin is read from its `package.json` `bin` field, never assumed, so a layout sous
  has since changed (the bin was once called `xcv`) still hands off.
- A copy never hands off to itself, compared by real path, which is what stops the project copy
  from handing off again once the global copy has handed off to it, and what makes `npx sous`
  behave exactly as before.

### Convenience, never a refusal

- Anything unreadable or ambiguous (a copy whose manifest does not name the package, a bin that
  cannot be determined or does not exist) means the invoked copy runs. The first copy found
  decides, usable or not; walking past a broken one to an older one further up would be a guess.
- `SOUS_NO_DELEGATE`, read like `SOUS_DEBUG`, keeps the invoked copy running, for debugging a
  broken project install or for deliberately using the global one.
- The notice goes to stderr, so a piped stdout is untouched, and only when the two versions
  differ; with `SOUS_DEBUG` set it prints on every hand-off, so "which copy ran?" is always
  answerable.

### The hand-off is plain JavaScript

- `src/lib/project-install.mjs` sits beside the config kernel for the same reason the kernel is
  `.mjs`: it runs under bare Node before tsx exists. It therefore cannot use the palette or the
  wrapper every other line of sous output goes through, and prints its one sentence plain. That
  is accepted as the cost of loading nothing before the decision is made.

### The release commit keeps sous's own lockfile in step

- The hand-off cannot protect the sous repository itself, which builds with its own checkout
  rather than a project install, and its lockfile drifted for a different reason: every merge
  to main publishes a patch, and the release commit moved `package.json` without moving the
  committed lockfile's `core/sous-skills` pin, so the next build on anyone's machine rewrote
  the lockfile to the version the release had set. `npm run version:sync`, which the release
  job already runs to hold the packaged recipe at the package version, now moves that lockfile
  entry too, with the hash of the packaged recipe as it stands after the bump, and the release
  commit carries the lockfile. The parity spec fails when the pin drifts, so a version set by
  hand in a pull request runs the same script.

## Consequences

- A team that installs sous in the project gets one build output however sous is invoked, and
  the committed lockfile stops depending on who ran the last build. The end-to-end test in
  `src/test/integration/project-install-e2e.test.ts` holds that promise against the packed
  tarball, offline.
- A machine with only a global install sees no change, and a project without a project install
  sees no change.
- The version a build was produced by is still recorded nowhere. That was part of the original
  issue and is left for its own effort; the hand-off removes the case that made it urgent.
