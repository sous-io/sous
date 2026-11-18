# Codex

Sous can write its instructions and skills for [Codex](https://github.com/openai/codex), OpenAI's coding
agent, and start it with `sous launch codex`. The part of Sous that does this is the built-in plugin
`@sous-io/sous-plugin-codex`.

!> **Untested.** Codex was not installed on the machine Sous's Codex support was built on, so none of it
has been run against Codex. It follows Codex's documentation and source code.

Three points in particular are unchecked:

1. that Codex reads an `AGENTS.override.md` at the project root in place of `AGENTS.md`;
2. that Codex reads that file when it is git-ignored, as Sous makes it;
3. what Codex does when its instruction files together pass its 32 KiB limit.
If you use Codex with Sous, please report what you see.

## Turning it on

The plugin is built in but does nothing until your project turns it on, so a project that never uses
Codex gets no Codex files. Write either of these in your config:

```jsonc
// .sous/sous.config.jsonc
{
    "plugins": {
        "options": {
            // Even an empty object turns Codex on.
            "@sous-io/sous-plugin-codex": {}
        }
    }
}
```

```jsonc
// .sous/sous.config.jsonc
{
    "tools": {
        // Settings for `sous launch codex`; writing this key also turns Codex on.
        "codex": {
            "args": ["--full-auto"]
        }
    }
}
```

To turn it off again, remove the key you wrote. To make sure it never loads, list it under
`plugins.disabled`.

## What Sous writes for Codex

Once it is on, every `sous build` writes:

| File | What it holds |
|---|---|
| `AGENTS.override.md` at the project root | Your project's own `AGENTS.md`, then Sous's memories |
| `.agents/skills/<skill>/` | The skills of the recipes you subscribe to |

### Why `AGENTS.override.md`

Codex reads one instruction file per folder. When a folder holds an `AGENTS.override.md`, Codex reads it
instead of that folder's `AGENTS.md`. Sous never touches your `AGENTS.md`; it writes the override file
with the text of your `AGENTS.md` first and its memories after it, so Codex sees both.

- If you have no `AGENTS.md`, the override holds only the memories.
- If you edit `AGENTS.md`, run `sous build` again, or Codex keeps reading the old copy.
- If your project already has an `AGENTS.override.md` that Sous did not write, Sous copies it to
  `.sous/backups/`, warns you, and writes its own.
- The file is build output, so Sous keeps it out of git: `sous init` adds `/AGENTS.override.md` to
  the project's `.gitignore`, and the plugin also declares that line as an
  [edit](editing-files.md), for projects set up before and for a file you have moved.

Codex cuts its project instruction files off at 32 KiB in total by default (its
`project_doc_max_bytes` setting). Your `AGENTS.md` plus Sous's memories can pass that, and the end of the
file is then lost.

Codex skips every project instruction file, `AGENTS.md` and the override alike, in a project you have
not marked as trusted in Codex.

### Where the memories come from

The same source as for Claude Code: `.sous/MEMORIES.tpl.md` when it exists, and otherwise your own files
under `.sous/memories/` followed by the memories of the recipes you subscribe to.

### Skills

Codex loads skills from `.agents/skills/` on demand, not into every session. Sous writes each recipe's
skills there. The folder is not added to `.gitignore`, because other tools read it too and a project
may keep its own skills there; add `/.agents/skills/` to your `.gitignore` yourself if every skill in it
comes from Sous. This location also comes from Codex's documentation and has not been tried.

## Options

Under `plugins.options."@sous-io/sous-plugin-codex"`:

| Option | Default | What it does |
|---|---|---|
| `memoriesOutputPath` | `${projectRoot}/AGENTS.override.md` | Where the memories file is written. A relative path is under the project root. |
| `prependMemoriesWith` | `${projectRoot}/AGENTS.md` | The file whose text goes before the memories. Skipped silently when it does not exist. |
| `skillsDirectory` | `.agents/skills` | Where skills are written. |
| `memories` | `true` | `false` writes no memories file for Codex. |

```jsonc
{
    "plugins": {
        "options": {
            "@sous-io/sous-plugin-codex": {
                "prependMemoriesWith": "${projectRoot}/docs/AGENTS.md"
            }
        }
    }
}
```

## Starting Codex

`sous launch codex` builds the project, then starts the `codex` command in the project root. Settings
under `tools.codex` change the command and add arguments before yours:

```bash
sous launch codex
sous launch codex -- resume
```

Sous does not run Codex headless (`codex exec`).

## Conditions on Codex

Sous builds the config once more for Codex while it is on, so a config value can depend on it with
`harness.id == 'codex'`. See [Conditions on the harness](configuration.md#conditions-on-the-harness).
