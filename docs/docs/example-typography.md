# Typography

?> This is an example page. It exists to show how standard markdown renders in the Sous docs
theme; it will be replaced by real reference content.

Body text is Open Sans at the design system's compact 14px base with a 1.6 line height. This
paragraph exists so you can see a plain block of prose next to everything else on the page,
including [a link](example-code.md), some **semibold emphasis**, some *italics*, and a bit of
`inline code`.

## Headings

Headings follow the `--sous-h1` through `--sous-h6` scale. Here is what the next two levels
look like:

### A third-level heading

Third-level headings mark subsections and appear in page anchors, but not in the sidebar (the
sidebar lists headings down to level two).

#### A fourth-level heading

Small enough to sit inside running text without shouting.

## Emphasis

- **Bold** renders at the semibold weight the design system uses for nav and labels
- *Italic* is plain italic
- ~~Strikethrough~~ works via GFM
- `inline code` gets the muted code chip treatment

## Lists

An unordered list with nesting:

- Config discovery walks up from the current directory
- Layers merge in filename order
  - `10-x.json` sorts before `2-x.json`
  - zero-pad numeric prefixes if ordering matters
- The merged result is validated once

And an ordered one:

1. Compile the templates
2. Prune stale outputs
3. Launch the agent

## Blockquote

> One config describes one project. Everything lives at the top level, and every value Sous
> acts on resolves through the same variable scope.

## Table

| Source | Precedence | Notes |
|--------|------------|-------|
| `--config` flag | highest | alias `--sous-config` |
| `SOUS_CONFIG` env var | second | real environment only |
| `--sous-dir` flag | third | points at a `.sous/` directory |
| `SOUS_DIR` env var | fourth | real environment only |
| walk-up discovery | lowest | first `.sous/` with a primary config |

## Horizontal rule and image

---

<img class="logo-light" src="../img/logo-on-white.png" width="160" alt="The Sous logo">
<img class="logo-dark" src="../img/logo-on-dark.png" width="128" alt="The Sous logo">
