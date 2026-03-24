---
name: about-liquid-templates
description: >
  YOU MUST load this skill when working with .tpl. files, deciding whether a file
  needs .tpl. naming, writing LiquidJS syntax in templates, or using custom tags or
  filters. Covers the .tpl. convention, LiquidJS syntax, custom tags, custom filters,
  and a live dump of all variables available in this project.
user-invocable: false
---

# About Liquid Templates

Files in this project with `.tpl.` in their filename are processed through LiquidJS
at compile time. The `.tpl.` segment is stripped from the output filename.

## The `.tpl.` Convention

| Source file          | Processed? | Output file       |
|----------------------|------------|-------------------|
| `SKILL.md`           | No         | `SKILL.md`        |
| `SKILL.tpl.md`       | Yes        | `SKILL.md`        |
| `config.tpl.sh`      | Yes        | `config.sh`       |
| `README.md`          | No         | `README.md`       |

**`SKILL.md` for any skill compiled by sous must always be `SKILL.tpl.md`** — the
required `## Source for this Skill` footer cannot be rendered without LiquidJS
processing. See `about-agent-skills` for the full rule.

For all other files, use `.tpl.` only when the file genuinely needs variable
substitution, partials, or conditionals. Static files are copied verbatim — faster
and safer.

## Syntax

Output a variable:

{% raw %}
```
{{ varName }}
```
{% endraw %}

Conditionals:

{% raw %}
```
{% if tool == "claude" %}
  ...
{% elsif tool == "codex" %}
  ...
{% else %}
  ...
{% endif %}
```
{% endraw %}

Loops:

{% raw %}
```
{% for item in items %}{{ item }}{% endfor %}
```
{% endraw %}

Assign a variable:

{% raw %}
```
{% assign name = "value" %}
```
{% endraw %}

Include another file at render time (path **relative to the template file's directory**):

{% raw %}
```
{% render "path/to/partial.md" %}
```
{% endraw %}

`render` resolves paths relative to the template file only — absolute paths do not work.
For files outside the template's directory tree, use the `@include` syntax instead (see
below).

To prevent template sequences from being processed in a code example, wrap the block in
`raw` / `endraw` tag blocks. These blocks cannot be nested — use one pair per code
example rather than one large wrapper.

## `@include` for Cross-Directory Files

The `@path` syntax is processed by the build system before LiquidJS runs. It includes
a file's content inline and resolves paths relative to the including file's directory.
Use it to pull in files from outside the template's own directory.

Write `@` immediately followed by a relative `.md` path on its own line with nothing
else on that line. Paths can traverse up with `../` as needed.

`@include` works in both `.tpl.` and plain `.md` files. Included content is subject to
LiquidJS rendering if the parent file is a `.tpl.`.

Undefined variables render as empty string — strict mode is off.

## Custom Tags

**`showVars`** — dumps all variables currently in scope as a fenced JSON block.
Useful during development to see exactly what variables are available at a given point
in a template. Remove before finalizing.

## Custom Filters

**`bulletList`** — converts an array variable to a markdown bullet list:

{% raw %}
```
{{ tags | bulletList }}
```
{% endraw %}

Output (if `tags` is `["a", "b", "c"]`):
```
- a
- b
- c
```

## Reference Files

- [liquid-filters.md]({{ sousRootPath }}/.claude/skills/about-liquid-templates/references/liquid-filters.md) — complete standard LiquidJS filter catalogue (string, array, number, date, default)

## Available Variables

The following variables are in scope at compile time in this project:

{% showVars %}

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
