/** The README of every well-known self-describing directory, ported from today's wording. */

import type { DirectoryReadme, SousDirectoryKind } from "./types.js";

/** The README each well-known directory gets. */
export const KNOWN_READMES: Readonly<Record<SousDirectoryKind, DirectoryReadme>> = {
    "sous-dir": {
        title: "The .sous directory",
        body: [
            "This directory holds this project's sous configuration: the main `sous.config.*` file, the `conf.d/` drop-in layers, the answers files and the lockfile.",
            "Most of it is committed to version control. Machine-specific files (the links map, the build state, the watcher's PID file and `.env.local`) are kept out by the sous-managed block in `.gitignore`.",
        ],
    },

    confd: {
        title: "conf.d: drop-in configuration layers",
        body: [
            "Every `.js`, `.mjs`, `.json`, `.jsonc` or `.yaml` file directly inside this directory is a configuration layer. Sous loads them after the project's main `sous.config.*` file, in filename order, and merges each one over what came before it.",
            "Layers numbered 500 through 599 are written by sous itself (for example `500-repos.jsonc`, recording the repositories this project trusts). Sous edits those files by key, so your comments, key order and formatting survive; it never touches the main config or any layer outside that band.",
            "You may add, edit and delete layers here yourself, including the ones sous writes. This directory is normally committed to version control along with the rest of `.sous/`; keep machine-specific paths and secrets out of it and put them in `.sous/.env.local` instead.",
        ],
    },

    "project-repos": {
        title: "repos: linked repository checkouts",
        body: [
            "`sous repo link` clones a recipe repository in here so you can work on it and on this project at the same time. Each checkout is an ordinary git working copy; sous reads from it and never writes to it.",
            "Everything here is machine-local. The `.gitignore` beside this file holds a single `*`, so nothing in this directory (these explanatory files included) is visible to the project's own repository.",
            "It is safe to delete a checkout once you have run `sous repo unlink` for it; sous goes back to the published version of that repository.",
        ],
    },

    "sous-home": {
        title: "Your user-level sous directory",
        body: [
            "This is `$SOUS_HOME` (`~/.sous` unless you set that variable). It holds the sous state that belongs to this machine rather than to any one project: the recipe cache in `cache/`, globally linked checkouts in `repos/`, and the machine-wide links map `sous.links.json`.",
            "No project reads its configuration from here, and nothing in here is committed anywhere. Sous recreates whatever it needs, so you can delete any of it; you will lose only cached downloads and the record of which repositories you linked globally.",
        ],
    },

    store: {
        title: "cache: the machine-wide recipe store",
        body: [
            "Sous downloads every recipe version it needs into this directory, one immutable folder per version, and verifies each one against its content hash before using it. Builds read from here, so a version is downloaded once and shared by every project on this machine.",
            "The store is disposable. Everything in it can be fetched again from the pins in each project's lockfile, so you may delete any part of it at any time; `sous repo gc` does the same thing tidily. Nothing here is committed, and editing a stored file only makes sous discard the entry as corrupted.",
        ],
    },

    "global-repos": {
        title: "repos: globally linked repository checkouts",
        body: [
            "`sous repo link --global` clones a recipe repository in here, where every project on this machine can use the same checkout. Each one is an ordinary git working copy; sous reads from it and never writes to it.",
            "Everything here is machine-local and is not committed anywhere. It is safe to delete a checkout once no project links to it any more; sous goes back to the published version of that repository.",
        ],
    },

    "index-cache": {
        title: "_indexes: cached repository indexes",
        body: [
            "Each repository sous knows about publishes one small index file listing the recipes and versions it offers. Sous keeps a copy of each here, beside a `.meta.json` sidecar recording when that copy was fetched.",
            "Sous writes these files; there is nothing here to edit. Deleting any of them is safe and costs only a refetch the next time the repository is consulted. Nothing here is committed.",
        ],
    },
};
