# S5: Config Expressions

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G3 (versatility, always), G4 (predictable and observable).

**Related:** S1 (the engine), S2 (config building, which decides when expressions are evaluated).

## What This Specifies

A config expression lets one value in a JSON, JSONC or YAML config file be decided when sous loads
the config, instead of being fixed when the file is written. Expressions ship in 1.0.0.

The case that started it: switching a subscription off on every host except Linux, inside
`conf.d/510-subscriptions.jsonc`, a file sous writes and the user may also edit. The user, describing
it:

> "I was trying to disable a specific subscription for a specific recipe on non-Linux hosts. So, I
> went into 510 and added something like `disabled: !platform.whatever !== "linux"`."
>
>   -- **Luke Chavers** in an agent session

Every rule below is marked as ruled by the user (quoted), decided in the planning session of
2026-10-18, accepted by the user on 2026-10-25, or an agent suggestion not yet ruled on.

## Who Owns What

- Config building (S2) decides when expressions are evaluated: each config file's contributor (the
  code that adds that file to the config) evaluates them before it adds the file's values, and
  evaluates the file again whenever a variable it read changes.
- `plugin-expressions` owns which expression languages exist. Each language is an
  `expression-language` entity (an object of a kind a plugin defines; see S1, the engine); Liquid is the first and the default. A plugin can add a
  language by adding an entity.

```ts
sous.entities.add("expression-language", liquidExpressionLanguage);
```

## The Guiding Principle

> "We want to apply the robustness principle: we will accept _many_ different forms of the same
> thing."
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

Every form below is accepted when read. Anything sous itself writes uses one form.

## Expression Objects

An **expression object** is a JSON object that stands in for a value. Sous evaluates it while
loading the config, and the result takes its place.

1. **Prefixed keys at the root.** Ruled:

   > "at the root, all special blocks must be prefixed with $."
   >
   >   -- **Luke Chavers** in an agent session (2026-10-18)

   "The root" is the object that stands in for the value (the value of `enabled` in the examples).

2. **The reserved keys are an exact list, not every `$` key.** (Accepted 2026-10-25.) The merged config
   already has a top-level `$schema` key, and a user may have other keys that start with `$`. Only
   these keys make an object an expression object:

   - `$expr`, and `$expr:<language>`
   - `$if`, and `$if:<name>`
   - `$elseif`, and `$elseif:<name>`
   - `$else`

3. **No mixing.** (Accepted 2026-10-25.) An object holding a reserved key and any key that is not
   reserved is an error naming the file, the key path and the stray key, so a typo such as `"$iff"`
   never passes through silently as config.

4. **Where expressions may appear.** Any value in a JSON, JSONC or YAML file, at any depth, including
   array items. (Ruled 2026-10-29; the user had said "(practically) anywhere".) A `.js` or `.mjs`
   file needs none, since it can compute its values directly.

5. **Nesting.** Decided: a `then` value, an `$else` value or an array item may itself be an
   expression object, evaluated the same way. Only the chosen branch is evaluated, so an expression
   in a branch that was not chosen cannot fail the load. A variable read inside a chosen nested branch is
   tracked like any other read, so a change to it re-evaluates the file (S2, config building).

```jsonc
{
    "recipes": {
        "skills": {
            "outputs": {
                "$if": {
                    "expr": "host.platform == 'darwin'",
                    "then": {
                        "$if": {
                            "expr": "env.CI == 'true'",
                            "then": ["/tmp/ci-skills"]
                        },
                        "$else": ["~/Library/agents/skills"]
                    }
                },
                "$else": [".claude/skills"]
            }
        }
    }
}
```

## What an Expression Can Read

- `host.platform`: Node's `process.platform` (`"win32"`, `"darwin"`, `"linux"` and the others Node
  lists).
- `env.<NAME>`: environment variables, after the env files load.
- Variables, by their bare name, as a template reads them (`machineRole == 'laptop'`). Decided: an
  expression sees the `_vars` of every level that contains it (see "Variable scopes" in S2, config building).
- Recipe answers, except in an expression under `subscriptions` or `repos` (see "Recipe answers" in S2, config building).

## Expression Languages

An expression is a string evaluated in a language. Liquid is the default and, for now, the only one.

1. A language may be named with a qualifier after a colon. Ruled:

   > "If we add other expression types later, we could add a qualifier... but still make the default
   > ("$expr") liquid."
   >
   >   -- **Luke Chavers**

   ```jsonc
   {
       "enabled": {
           "$expr:liquid": "host.platform != 'win32'"
       }
   }
   ```

2. The qualifier is also allowed on the expression inside a branch. Ruled:

   > "expressions inside of ifs/elseif will _also_ allow the language qualifier."
   >
   >   -- **Luke Chavers** in an agent session (2026-10-18)

   ```jsonc
   {
       "foo": {
           "$if": {
               "expr:liquid": "host.platform != 'win32'",
               "then": "bar"
           }
       }
   }
   ```

3. A Liquid expression is evaluated with LiquidJS `evalValueSync`, the way a `{% if %}` condition
   is, so filters, `and` and `or` work. (Checked with the installed LiquidJS: `host.platform !=
   "win32"` returned `true` on Linux.)

    An expression may use the Liquid filters plugins add, as well as LiquidJS's own (ruled
    2026-10-29). Filters are entities, and a plugin loaded in a later pass can add one, so:

    - An expression that uses a filter not loaded yet gives `undefined` for that pass, as an
      unknown variable does, and is evaluated again on the next pass.
    - If the filter still does not exist once the config has settled, that is an error naming it.
    - A filter used in a config expression must give the same result for the same input, like every
      contributor (S2, config building). One that reads the clock or the network can stop the config
      from settling, and the engine's loop detection (S1, the engine) names the expression.

    ```jsonc
    {
        "enabled": {
            "$if": "env.CI | is_truthy"          // is_truthy comes from a plugin
        }
    }
    ```

4. An unknown language is an error naming it and the languages sous knows. (Accepted 2026-10-25.)

5. A recipe's config file may use Liquid, but no language that runs code. (Accepted 2026-10-25.) Sous
   runs nothing inside a repository until the repository is trusted, and code a recipe runs comes as
   a bundled plugin (S1, the engine). A recipe's config file stays data, so a `js` expression language is not
   allowed in it.

## `$expr`: a Computed Value

`$expr` computes a value, and the result is used as it is: a string stays a string, a number a
number.

```jsonc
{
    "label": {
        "$expr": "host.platform | upcase"
    }
}
```

On Linux, `label` is `"LINUX"`. `$if` chooses between values; `$expr` computes one. (Agent
suggestion: document them that way, so each has one job.)

## `$if` and `$elseif`: Branches

A **branch** is one condition and the value it gives when the condition is true. A **chain** is
every branch in one expression object, tried in order; the first branch whose condition is true gives
the value, and no later branch is evaluated.

### The forms of one branch

Ruled, for the `$` inside a branch:

> "within blocks, $ is optional, but allowed on expr, then, etc ($expr)"
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

Every one of these is one branch:

```jsonc
{
    "a": { "$if": "host.platform != 'win32'" },
    "b": { "$if": { "expr": "host.platform != 'win32'" } },
    "c": { "$if": { "expr": "host.platform != 'win32'", "then": "bar" } },
    "d": { "$if": { "$expr": "host.platform != 'win32'", "$then": "bar" } },
    "e": { "$if": { "expr:liquid": "host.platform != 'win32'", "then": "bar" } }
}
```

- `a` is the condition alone, as a string.
- `b` is the condition alone, as a block.
- `c` is the condition and its value.
- `d` is `c` with the optional `$`.
- `e` is `c` with a language qualifier.

Accepted 2026-10-25:

1. A block holding both `expr` and `$expr`, or both `then` and `$then`, is an error.
2. A block holding any other key is an error.
3. Every form is also accepted under `$elseif`.

### Arrays

Ruled:

> "Yes, allowing $elseif to accept an array is a good idea."
>
> "we will also allow $if to accept an array"
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

Each item of the array is one branch, in any form above, tried in array order:

```jsonc
{
    "foo": {
        "$if": [
            {
                "expr": "host.platform == 'win32'",
                "then": "bar"
            },
            {
                "expr": "host.platform == 'linux'",
                "then": "barx"
            }
        ],
        "$else": "bad"
    }
}
```

Accepted 2026-10-25: an array item with no `expr` is a fallback, allowed only as the last item of the
last key in the chain, and an error anywhere else. It means the same as `$else`, so a chain holding
both is an error.

### Qualifiers and order

Ruled:

> "we will also allow both if and elseif to accept a qualifier, e.g. "$elseif:two". 5) so basically
> $elseif becomes an alias for $if, the _only_ difference is that $elseif will always be processed
> after $if. 6) when we have multiple ifs or elseifs, ifs will be processed first, in alphabetical
> order (no qualifier is always first), then elseifs in alphabetical order."
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

A qualifier is what lets one object hold several `$if` or `$elseif` keys, since JSON allows each key
once. The order of a chain:

1. `$if`, then every `$if:<name>` in name order.
2. `$elseif`, then every `$elseif:<name>` in name order.
3. Inside a key holding an array, the array's order.
4. `$else` last.

The order the keys are written in the file does not matter.

Accepted 2026-10-25:

1. "Alphabetical" is a bytewise sort, the one `conf.d/` uses, so the order is the same on every
   machine whatever its locale. The same gotcha applies: `$if:10` sorts BEFORE `$if:2`, so zero-pad
   numbers (`$if:02`, `$if:10`).
2. After `$if:` and `$elseif:`, a qualifier is always a name, never a language. The language goes on
   the expression inside the branch, so `$if:liquid` cannot mean two things.
3. An empty name (`"$if:"`) is an error.

## What a Chain Gives

### Results

The user's first sketches:

> "When `$if` is a string, its just evaluated and, no matter what, it's cast to a booolean"
>
> ""bar" or undefined; we don't output undefined values"
>
>   -- **Luke Chavers**

Ruled 2026-10-25, written to give those results:

1. A branch with a `then` gives its `then` value when its condition is true.
2. A branch with no `then` gives `true` when its condition is true.
3. When no condition is true, the chain gives the `$else` value if there is one, and `undefined`
   otherwise, whether or not its branches have a `then`. The key is then dropped, so an earlier
   file's value stands:

    > "it should return undefined, causing the `enabled` property to be dropped so that it doesn't
    > affect the existing value"
    >
    >   -- **Luke Chavers** in an agent session (2026-10-25)

    ```jsonc
    // conf.d/610-linux-only.jsonc
    {
        "subscriptions": {
            "tool-usage/automated-browser-tasks": {
                // Linux: true. Elsewhere: undefined, dropped; the 510 value stands.
                "enabled": { "$if": "host.platform == 'linux'" }
            }
        }
    }
    ```

    To switch the subscription off elsewhere, the file says so: `"$else": false`.
4. An object holding only `$else` gives its value.
5. An `$elseif` with no `$if` is allowed, and is simply the first branch, since `$elseif` is an
   alias for `$if` processed after it.

### `undefined` is dropped; empty objects are kept

A key whose value comes out `undefined` is dropped from the file it is in. Ruled:

> "Since we have an $if and no $else, then the evaluation resolves `undefined` and, as I said in a
> previous rule, we will drop undefined values. Right?"
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

An empty object is NOT dropped. Ruled:

> "ok, I agree with keeping empty objects."
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

An empty object can be a complete value. Every field of a subscription entry is optional, so `{}`
means "subscribe at any version, with every default":

```jsonc
// conf.d/510-subscriptions.jsonc
{
    "subscriptions": {
        "tool-usage/automated-browser-tasks": {
            "enabled": {
                "$if": {
                    "expr": "host.platform == 'win32'",
                    "then": false
                }
            }
        }
    }
}
```

On Linux, `enabled` comes out `undefined` and is dropped, which leaves:

```jsonc
{
    "subscriptions": {
        "tool-usage/automated-browser-tasks": {}
    }
}
```

The subscription stays, enabled by default. Dropping empty objects too would remove the subscription
on the one platform it was meant to stay on.

## `$else`

`$else` holds the value the chain gives when no condition is true, written as it is:

```jsonc
{
    "foo": {
        "$if": {
            "expr": "host.platform != 'win32'",
            "then": "bar"
        },
        "$else": "bad"
    }
}
```

There is no `{ "then": ... }` form of `$else`. Ruled:

> "lets just drop the "verbose" form of $else. I don't think it adds any value."
>
>   -- **Luke Chavers** in an agent session (2026-10-18)

So an `$else` value is used as written, an object holding a `then` key included, and so is the value
of a `then` inside a branch (unless it is itself an expression object; see "Nesting").

## What Sous Writes

Sous edits the files it manages surgically, changing only the keys it means to and keeping
everything else, comments included (S2, config building). So:

1. `sous subscription disable <ref>` and `enable <ref>` replace the whole `enabled` value, expression
   included, with `false` or `true`.
2. Every other edit sous makes leaves an expression it did not set exactly as written, comments
   included.
3. The `sous` program may write an expression when it needs to, always in one standard form. "Sous
   writes" here means the `sous` program changing a file itself, as `sous subscription add` does;
   an agent or a person editing a config file is a user edit, which may use any accepted form.

    ```jsonc
    // The one form sous writes
    {
        "enabled": {
            "$if": {
                "expr": "host.platform == 'darwin'",
                "then": false
            }
        }
    }
    ```

The user's guideline for expressions, for sous's own features, recipes and the people designing
them:

> "expressions are not easy to read and should only be used when no, other, more user-friendly
> feature is available or could be easily made"
>
>   -- **Luke Chavers** in an agent session (2026-10-25)

## Truth and Falsehood

A condition is true or false by Liquid's rules, as in a template's `{% if %}`. Checked with the
installed LiquidJS: only `false` and a missing value (`undefined`, `null`) are false. The empty
string `""`, the number `0` and the string `"false"` are all true.

Environment variables are always strings, so this is the trap to document:

```jsonc
{
    "enabled": {
        "$if": "env.SKIP_BROWSER"
    }
}
```

With `SKIP_BROWSER=false`, that condition is TRUE. Compare the string instead:

```jsonc
{
    "enabled": {
        "$if": "env.SKIP_BROWSER != 'true'"
    }
}
```

Accepted 2026-10-25: follow Liquid's rules and document the trap, so a condition means the same in a
config as in a template.

## Errors

Accepted 2026-10-25. Each fails the load as a `ConfigError` naming the file the expression came from and
its key path:

1. A reserved key mixed with an unreserved one.
2. An unknown key, or both spellings of one key, in a branch block.
3. A fallback array item that is not last, or a fallback together with an `$else`.
4. An empty qualifier, or an unknown language.
5. An expression Liquid cannot parse, or one that fails while evaluating.
6. A variable still unknown when the load settles.
7. A config that does not settle within the pass limit (S2, config building).
8. An expression under `subscriptions` or `repos` that reads a recipe answer (S2, config building).

## Full Examples

`conf.d/510-subscriptions.jsonc`, subscribing to one recipe everywhere and to another everywhere
except Windows:

```jsonc
// Subscriptions sous manages for this project.
// sous edits this file by key; you may edit it too.
{
    "subscriptions": {
        "workflow/github-projects": {
            "range": "^1.0.0"
        },
        "tool-usage/automated-browser-tasks": {
            "range": "^2.1.0",
            "enabled": {
                "$if": "host.platform != 'win32'"
            }
        }
    }
}
```

The same `enabled` value in other accepted forms, all meaning the same:

```jsonc
{
    "form-1": {
        "$if": {
            "expr": "host.platform != 'win32'"
        }
    },
    "form-2": {
        "$if": {
            "$expr:liquid": "host.platform != 'win32'"
        }
    },
    "form-3": {
        "$if": {
            "expr": "host.platform == 'win32'",
            "then": false
        },
        "$else": true
    },
    "form-4": {
        "$expr": "host.platform != 'win32'"
    }
}
```

A value with three outcomes, written with qualifiers:

```jsonc
{
    "recipes": {
        "skills": {
            "outputs": {
                "$if:01-windows": {
                    "expr": "host.platform == 'win32'",
                    "then": ["C:/agents/skills"]
                },
                "$if:02-mac": {
                    "expr": "host.platform == 'darwin'",
                    "then": ["~/Library/agents/skills"]
                },
                "$else": [".claude/skills"]
            }
        }
    }
}
```

## `.js` Layers Get No Expression Helper

Ruled 2026-10-25: `builder` gets no method that evaluates an expression object. A `.js` or `.mjs`
layer computes its values in JavaScript. A helper can be added later without breaking anything.

## Open Questions

None.

## Changes

None yet.
