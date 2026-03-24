# String Substitutions

Skills support dynamic substitution in the skill body content.

## Argument Substitutions

| Variable        | Description |
|:----------------|:------------|
| `$ARGUMENTS`    | All arguments passed when invoking the skill. If not present in content, arguments are appended as `ARGUMENTS: <value>`. |
| `$ARGUMENTS[N]` | A specific argument by 0-based index. `$ARGUMENTS[0]` is the first argument. |
| `$N`            | Shorthand for `$ARGUMENTS[N]`. `$0` = first argument, `$1` = second, etc. |

### Example

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

Running `/migrate-component SearchBar React Vue` substitutes `SearchBar`, `React`, `Vue`.

If arguments are passed but `$ARGUMENTS` (or `$N`) is not present in the content,
The agent appends `ARGUMENTS: <value>` to the end of the skill content automatically.

## Session and Path Substitutions

| Variable               | Description |
|:-----------------------|:------------|
| `${CLAUDE_SESSION_ID}` | The current session ID. Useful for logging or creating session-specific files. |
| `${CLAUDE_SKILL_DIR}`  | Absolute path to the skill's directory. Use to reference bundled scripts or files regardless of current working directory. |

### Example using `$CLAUDE_SKILL_DIR`

```yaml
---
name: run-check
allowed-tools: Bash
---

Run the validation script:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/validate.sh
```
```
