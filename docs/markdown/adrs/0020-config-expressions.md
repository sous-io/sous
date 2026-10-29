# ADR 0020: Config expressions

**Status:** Accepted, 2026-10-29.

This record summarizes a decision of the 1.0 architecture. The source of truth is
[S5: Config Expressions](../architecture/specifications/S5-config-expressions.md), with when they
are evaluated in [S2: Building the Config](../architecture/specifications/S2-config-building.md)
("Config expressions are part of the same loop"). Where this record and those files disagree, they
win.

## Context

A JSON, JSONC or YAML config file can only hold fixed values, so a value that should differ by
machine needs a `.js` config file. The case that started it was switching one subscription off on
every host but Linux, inside `conf.d/510-subscriptions.jsonc`, a file sous writes and the user may
also edit:

> "I was trying to disable a specific subscription for a specific recipe on non-Linux hosts. So, I
> went into 510 and added something like `disabled: !platform.whatever !== "linux"`."
>
>   -- **Luke Chavers** in an agent session

## Decision

- **An expression object stands in for a value**, at any depth of a JSON, JSONC or YAML config file,
  array items included. Only these keys make an object an expression object: `$expr` (and
  `$expr:<language>`), `$if` (and `$if:<name>`), `$elseif` (and `$elseif:<name>`) and `$else`.
  Mixing a reserved key with any other key is an error, so a typo never passes silently.
- **Liquid is the first and default expression language**; a plugin may add another as an
  `expression-language` entity. Expressions may use every Liquid filter plugins add.
- **A chain that matches nothing gives `undefined`, and the key is dropped**, so a value can be
  switched off on some machines and left untouched on others.
- **Expressions are evaluated inside each file's contributor** (ADR 0015), before its values reach
  the patch; every variable an expression reads is a recorded read, so the file re-runs when that
  variable changes.
- **An expression under `subscriptions` or `repos` may not read recipe answers**, since which
  recipes are pinned depends on those keys.
- **Sous accepts many forms when reading, and writes one.**

## Consequences

- The example that started it works:

    ```jsonc
    // conf.d/610-mac.jsonc
    {
        "subscriptions": {
            "tool-usage/automated-browser-tasks": {
                "enabled": {
                    "$if": {
                        "expr": "host.platform == 'darwin'",
                        "then": false
                    }
                }
            }
        }
    }
    ```

- `sous config show` and `sous config get` print evaluated values; `--layers` shows each expression
  as written, what it evaluated to and the values it read.
- A `.js` config file needs no expression helper, since it computes its values directly.
