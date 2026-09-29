# conf.d: drop-in configuration layers

Every `.js`, `.mjs`, `.json`, `.jsonc` or `.yaml` file directly inside this directory is a configuration layer. Sous loads them after the project's main `sous.config.*` file, in filename order, and merges each one over what came before it.

Layers numbered 500 through 599 are written by sous itself (for example `500-repos.jsonc`, recording the repositories this project trusts). Sous edits those files by key, so your comments, key order and formatting survive; it never touches the main config or any layer outside that band.

You may add, edit and delete layers here yourself, including the ones sous writes. This directory is normally committed to version control along with the rest of `.sous/`; keep machine-specific paths and secrets out of it and put them in `.sous/.env.local` instead.
