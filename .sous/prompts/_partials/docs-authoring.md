### Publishing documentation

- Documentation pages are plain markdown files in `docs/markdown/` (repo
  path). Each page is served live at
  `https://sous-io.github.io/sous/markdown/#/<page-name>` (the filename minus
  `.md`); docsify fetches and renders the markdown in the browser.
- Publishing a page = commit the `.md` file and add one line to
  `docs/markdown/_sidebar.md`. No build step, no HTML edits.
- `_sidebar.md` must stay a TIGHT markdown list (no blank lines between
  items). Non-link items (`- **Section**`) render as section labels.
- Deep links: every page is `#/<name>`, every heading gets
  `#/<name>?id=<heading-slug>`, and both survive refresh.

### Formatting palette

Standard GFM (tables, task lists, strikethrough, fenced code with language
tags) plus:

- `?> text` renders a NOTE callout; `!> text` renders an IMPORTANT callout.
  Docsify's class names run backwards (`!>` emits `p.tip`, `?>` emits
  `p.warn`); the styling is correct, so trust the syntax, not the classes.
- A ```` ```term ```` fence renders an animated terminal that types its
  commands and plays on first scroll-into-view. Line syntax: `$ ` typed
  input, `// ` subtle comment, `>> ` progress bar, blank line = spacer,
  anything else = printed output. The fence MUST start at column 0; an
  indented ```` ```term ```` block renders literally (that is how the
  example page documents the syntax).
- Fenced code is Prism-highlighted; the loaded grammars are pinned as script
  tags in `docs/markdown/index.html`.
- Logo images must be authored as a theme pair, and one shows per theme:
  `<img class="logo-light" src="../img/logo-on-white.png">` plus
  `<img class="logo-dark" src="../img/logo-on-dark.png">`.
- Pages must stay meaningful as plain markdown files: never carry meaning
  only in images or embedded HTML.
