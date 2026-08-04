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

## Two Syntaxes — Do Not Mix

Sous uses two different variable syntaxes at two different stages. Using the wrong one in
the wrong place silently produces the literal text instead of a value.

| Syntax | Where it belongs | Resolved by |
|--------|------------------|-------------|
| {% raw %}`${varName}`{% endraw %} | `_vars` blocks and target paths in a sous **config** file | sous, during config load |
| {% raw %}`{{ varName }}`{% endraw %} | the body of a `.tpl.` **template** file | LiquidJS, at render time |

The one crossover is `@`-include paths, which accept {% raw %}`${var}`{% endraw %}
substitution because the include processor runs before LiquidJS (see below).

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

`render` resolves paths relative to the template file. For files outside that tree, use
a path **alias** (`@~sous-shared/...`, `@~project/...`, or a user-defined alias) or a
`@`-prefixed `${var}` path — the same alias resolution as `@include` (see below) works in
`render` too.

To prevent template sequences from being processed in a code example, wrap the block in
`raw` / `endraw` tag blocks. These blocks cannot be nested: the first `endraw`
encountered closes the block, so a nested pair leaks its remainder into the output. Use
one pair per code example rather than one large wrapper.

## `@include` for Cross-Directory Files

The `@path` syntax is processed by the build system before LiquidJS runs. It includes
a file's content inline. Write `@` immediately followed by a `.md` path on its own line
with nothing else on that line.

`@include` works in both `.tpl.` and plain `.md` files. Included content is subject to
LiquidJS rendering if the parent file is a `.tpl.` (so a Liquid tag inside the included
file runs in the parent's render pass).

The engine sets both `strictVariables: false` and `strictFilters: false`. An undefined
variable renders as an empty string, and an **unknown filter silently no-ops**, passing
its input through unchanged. Neither mistake raises an error, so a typo in a variable or
filter name shows up only as missing or unfiltered output.

### Gotcha: `@include` fires inside fenced code blocks

The `@include` processor runs on the raw file content *before* LiquidJS and has no
markdown awareness whatsoever — it matches any line that is nothing but an `@`-prefixed
`.md` path. A fenced code block does not protect it: an `@path.md` line inside triple
backticks is still executed and replaced with the file's content. There is no escape
syntax. To show an `@`-path as an example, put something else on the line (indent it,
prefix it with a word, or wrap it in backticks inline).

### Path forms

A `@`-path may be any of:

- **Relative** to the including file: `@sections/intro.md` (traverse up with `../`).
- **Variable-substituted**: `@${sousRootPath}/shared-prompts/x.md` — `${var}` is
  substituted before resolving; if the result is absolute it is used directly.
- **Aliased**: `@<alias>/rest.md`, where the first segment names a registered alias.

### Path aliases

The first path segment, up to the first `/` or `:` (both separators work — `@a/b.md`
≡ `@a:b.md`), is matched against the alias registry. Built-in aliases are reserved and
always begin with `~`:

- `@~sous-shared/...` → the Sous CLI's `shared-prompts` directory (skills, memories,
  `_partials`, etc.). Example: `@~sous-shared/_partials/resume-task.md`.
- `@~project/...` → the consuming project's root.

Projects register their own aliases in settings via an `_aliases` block (root and/or
project level); names may **not** start with `~` (reserved). An alias value is a string
or an array of strings (each may use `${var}`):

```
_aliases: { myDocs: "${projectRoot}/docs", shared: ["${a}", "${b}"] }
```

### Resolution order

For each `@`-path, candidates are tried in order and the **first that exists on disk
wins**; if none exist, the build errors listing every path tried:

1. Each base of the matched alias, in order (project `_aliases` are tried before root,
   before built-in bases of the same name).
2. The path resolved **relative to the including file** — using the *full* path
   including the alias segment. So an alias miss can fall through to a real relative
   directory of the same name, letting an alias **augment** a local directory.

## Custom Tags

**`showVars`** — dumps all variables currently in scope as a fenced JSON block.
Useful during development to see exactly what variables are available at a given point
in a template. Remove before finalizing.

**`getFiles`** — globs files under a root directory and assigns the resulting array to a
template variable. It renders nothing; present the results yourself with a `for` loop.
Each entry has `path`, `dir`, `relPath`, and `name`. `include`/`exclude` take
comma-separated glob patterns matched relative to `root`, and attribute values may be
quoted strings or scope variables. The optional `import="<exportName>"` dynamically
imports each file and attaches that export to the entry (files that fail to import, or
that lack the export, are dropped) — this is how a manifest of scripts reads its own
metadata:

{% raw %}
```
{% getFiles tasks root=scriptsDir include="*.mjs" import="meta" %}
{% for t in tasks %}
### {{ t.meta.name }}
- Script: `{{ t.path }}`
{% endfor %}
```
{% endraw %}

**`listFiles`** — the convenience counterpart to `getFiles`: it globs and renders a
markdown bullet list of file names inline, with no loop needed. Add `relative="true"` to
render paths relative to the root instead of bare file names:

{% raw %}
```
{% listFiles root=scriptsDir include="*.mjs" %}
```
{% endraw %}

**`exportScalarVarsJs`** — emits every in-scope scalar variable (string, finite number,
boolean) as an ES module default export, keys sorted. Objects, arrays, `null` and
non-finite numbers are skipped. Use it to compile a settings module that runtime code
imports, rather than re-deriving project configuration:

{% raw %}
```
{% exportScalarVarsJs %}
```
{% endraw %}

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

Given a non-array value, `bulletList` returns it as a plain string with no bullet.

## Authoring Guidelines

Templates (`.tpl.*` files) must be **maximally reusable**. A well-written template
can be copied between projects or shared across teams without edits — only the
project's variables change.

**Rules:**

1. **Never hard-code values that could differ between projects.** If a value comes
   from project configuration (board IDs, project keys, sprint IDs, URLs, user info),
   use a variable. When no suitable variable exists, add one to the project's sous
   config file (the file that defines the project's `_vars`).
2. **Guard project-specific blocks with conditionals.** If a section only applies when
   a variable is set, wrap it in {% raw %}`{% if varName %} ... {% endif %}`{% endraw %} so the
   block disappears cleanly for projects that don't define it.
3. **Prefer derived variables over raw values.** Example: `ticketPrefix` is derived
   from `jiraProjectKey` — templates use `ticketPrefix` so they stay correct if the
   key changes.
4. **Test portability mentally.** Before finalizing a template, ask: "If I compiled
   this for a different project with different settings, would the output still make
   sense?" If not, parameterize the varying part.

## Reference Files

- [liquid-filters.md](references/liquid-filters.md) — complete standard LiquidJS filter catalogue (string, array, number, date, default)

## Available Variables

The following variables are in scope at compile time in this project:

{% showVars %}

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a template and
the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
