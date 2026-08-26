# Discovery and Overrides

How sous locates a project's configuration, and every way to override it. All of this runs
in `BaseCommand.init()` on every command; there is no opt-out.

## Locating the primary config

Precedence, highest first. Flags beat env vars; both beat walk-up discovery:

1. `--config <path>` (`-c`), or its verbose alias `--sous-config <path>`.
2. `SOUS_CONFIG` environment variable.
3. `--sous-dir <path>` flag.
4. `SOUS_DIR` environment variable.
5. Walk UP from the working directory to the filesystem root, taking the first `.sous/`
   directory that holds a primary config. A `.sous/` without one does not stop the walk.

Every flag or env value resolves with the same rules. It may point at:

- a config file directly,
- a directory holding one of the primary config names, or
- a directory whose `.sous/` child holds one (so `--config .` works from a project root).

Leading `~` expands to the user's home directory. An empty or whitespace-only value (for
example a bare `export SOUS_CONFIG=`) is treated as UNSET and falls through to the next
tier; it never hijacks resolution. Error messages name the source that was actually set
(`--sous-dir`, `SOUS_CONFIG`, and so on), not a generic flag.

## Locating the conf.d layer directory

Precedence: `--sous-confd <path>` flag, then `SOUS_CONFD` env var, then the default
`<sousDir>/conf.d`. An override flows everywhere the default would: layer enumeration,
the duplicate-baseName check, and watch-mode reload.

## Why SOUS_* env vars come from the real environment only

Sous loads `<sousDir>/.env.local` and `<sousDir>/.env` into the process environment, but
finding those files requires knowing `sousDir` first. The location vars (`SOUS_CONFIG`,
`SOUS_DIR`, `SOUS_CONFD`) are therefore read from the real shell environment BEFORE any
env file loads; setting them inside `.env.local` has no effect on discovery.

## Env file layering

After discovery, sous loads two optional files from the discovered `.sous/`:

- `.env.local`: gitignored; machine-specific values and secrets.
- `.env`: committed; team-shared defaults.

Load order is `.env.local` first, then `.env`, and no load ever overwrites a value that is
already set. Effective precedence is therefore: real shell environment, then `.env.local`,
then `.env`. Syntax is deliberately small (not a shell): `KEY=value` lines, `#` comments,
optional `export ` prefix, single or double quoted values (`\n` and `\t` expand inside
double quotes), and inline `# comment` stripped from unquoted values. Lines without `=`
are ignored.

## Discovery errors

All are hard `ConfigError`s; sous never guesses:

- **No config found**: the error lists every directory checked during the walk and shows
  a minimal starter config.
- **Multiple primary configs**: two or more of `sous.config.js|mjs|json|yaml` in the same
  `.sous/` is an error naming every candidate.
- **Duplicate layer baseNames**: any two loaded files (primary or conf.d) whose names
  differ only by extension is an error naming both files, because their merge order would
  otherwise depend on extension.

## Interaction with `xcv launch` pass-through

`launch` forwards unrecognized arguments to the launched tool. The `--sous-config`,
`--sous-dir` and `--sous-confd` flags are declared on every command, so launch CONSUMES
them rather than forwarding. To pass a literally-named flag through to the tool, put it
after a bare `--`, which forwards everything following it verbatim.
