---
name: about-liquid-templates
description: >
  YOU MUST load this skill when working with .tpl. files in sous, deciding whether a file
  needs .tpl. naming, writing LiquidJS syntax in templates, or using {% render %}, {% if %},
  {{ varName }}, or any Sous custom tags/filters. Covers LiquidJS syntax, the .tpl. convention,
  custom tags, custom filters, and the raw escape pattern.
user-invocable: false
---

# Abstract

This topical skill covers LiquidJS as used in the `sous` project: when templates are
processed, what syntax is available, and the Sous-specific extensions.

## Two Syntaxes — Do Not Mix

Sous uses two distinct variable syntaxes for two different purposes:

- **`${varName}`** — used inside `_vars` blocks in the settings file. Resolved by Sous
  internally during config loading.
- **`{{ varName }}`** — used inside `.tpl.` template files. Resolved by LiquidJS at
  render time.

Never write `{{ varName }}` in a settings file or `${varName}` in a template file.

## The `.tpl.` Convention

Files **without** `.tpl.` in the filename are copied verbatim — no processing of any kind.
Files **with** `.tpl.` in the filename are rendered through LiquidJS and `.tpl.` is
stripped from the output filename.

| Source file               | Processed? | Output file           |
|---------------------------|------------|-----------------------|
| `SKILL.md`                | No         | `SKILL.md`            |
| `SKILL.tpl.md`            | Yes        | `SKILL.md`            |
| `config.tpl.sh`           | Yes        | `config.sh`           |
| `README.md`               | No         | `README.md`           |

**`SKILL.md` for any skill compiled by sous must always be `SKILL.tpl.md`** — the
required `## Source for this Skill` footer cannot be rendered without LiquidJS
processing. See `about-agent-skills` for the full rule.

For all other files, use `.tpl.` only when the file genuinely needs:
- Variable substitution: `{{ projectRoot }}`, `{{ tool }}`
- Partial includes: `{% render "path/to/partial.md" %}`
- Conditionals: `{% if someVar == "true" %}...{% endif %}`

**`entryPoint` exception:** files used as `entryPoint` in a compilation target are always
rendered through LiquidJS regardless of filename. The `.tpl.` convention applies only to
glob targets (`entryGlob` / `destinationDir`).

## Standard LiquidJS Tags

```liquid
{{ varName }}                          — output a variable (undefined → empty string)

{% if tool == "claude" %}
  ...
{% elsif tool == "codex" %}
  ...
{% else %}
  ...
{% endif %}

{% for item in items %}{{ item }}{% endfor %}

{% assign greeting = "hello" %}

{% capture block %}
  multi-line content
{% endcapture %}

{% render "path/to/partial.md" %}      — include another file at render time
```

Sous configures LiquidJS with `strictVariables: false` and `strictFilters: false` —
undefined variables and unknown filters silently produce empty output rather than errors.

The following `sous*` vars are always in scope during rendering:

| Variable            | Value |
|:--------------------|:------|
| `sousRootPath`      | Absolute path to the Sous CLI install directory |
| `sousVersion`       | Current CLI version string |
| `sousTemplatePath`  | Absolute path to the `.tpl.` file being rendered |
| `sousTemplateDir`   | Directory of the `.tpl.` file being rendered |

## Escaping Template Sequences

Code examples in `.tpl.` files that contain `{{` or `{%` sequences must be wrapped in
`{% raw %}...{% endraw %}` to prevent LiquidJS from trying to process them:

```liquid
{% raw %}
{{ this will not be processed }}
{% endraw %}
```

**`{% raw %}` blocks cannot be nested.** The first `{% endraw %}` encountered always
closes the current block — even if it appears inside a fenced code example within the
block. To document the `{% raw %}`/`{% endraw %}` pattern inside a `.tpl.` file, describe
it in prose rather than a code block. Use individual `{% raw %}...{% endraw %}` pairs per
code example rather than one large wrapper block.

## `{% render %}` Partials

Paths resolve **relative to the template file's directory only**. The engine root is
always the template's own directory — absolute paths do not work.

```liquid
{% render "partials/intro.md" %}
{% render "../shared/header.md" %}
```

**Do not** use `sousRootPath` with `{% render %}` for cross-directory includes — LiquidJS
cannot resolve absolute paths against its root. Use `@include` instead (see below).

## `@include` for Cross-Directory Files

The `@path` syntax is a Sous compile-time feature (not LiquidJS). It expands a file's
content inline before LiquidJS rendering runs, and resolves paths relative to the
including file's directory. Use it to include files outside the template's own directory
tree, including files from elsewhere in the sous repo:

`@include` works in both `.tpl.` and plain `.md` files. It is processed first, so
included content is subject to LiquidJS rendering if the parent file is a `.tpl.`.

**Critical:** the `@include` processor runs on the raw file content before LiquidJS and
has no awareness of markdown structure — it will execute `@path.md` even if that line
appears inside a fenced code block. Never put an `@`-prefixed `.md` path on its own line
in a code example inside a `.tpl.` file. In the shared `about-liquid-templates/SKILL.tpl.md`,
this means `@include` examples must be described in prose with inline code, not as
fenced code blocks.

## Sous Custom Tags

### `{% showVars %}`

Dumps all variables currently in scope as a fenced JSON block. Useful during development
to inspect what variables are available at a given point in a template:

```liquid
{% showVars %}
```

Output:
```
# Sous Debug: Variable Dump
```json
{ "projectRoot": "/home/user/projects/myapp", "tool": "claude", ... }
```
```

Remove `{% showVars %}` calls before finalizing a template — they are a development aid,
not intended for production output.

## Sous Custom Filters

### `bulletList`

Converts an array variable to a markdown bullet list:

```liquid
{{ tags | bulletList }}
```

If `tags` is `["sous", "xcv", "templates"]`, output is:
```
- sous
- xcv
- templates
```

If the input is not an array, it is returned as a plain string.

## Reference Files

- [references/liquid-filters.md](references/liquid-filters.md) — complete standard LiquidJS filter catalogue (string, array, number, date, default)

# Other Skills

YOU MUST load `about-shared-skills` for context on where `.tpl.` files live in the sous
project and how they are compiled. YOU MUST load `about-agent-skills` for general skill
structure and architecture.