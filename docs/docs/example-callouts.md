# Callouts and tasks

?> This is an example page. It shows the docsify callout helpers and GFM task lists; it will be
replaced by real reference content.

## Notes

A line starting with `?>` renders as a note, using the design system's info dim pair:

?> Sous never reads `SOUS_*` variables from `.env.local`; they are resolved from the real
environment only, because they decide where `.env.local` itself lives.

## Important

A line starting with `!>` renders as an important warning, using the danger dim pair:

!> Never edit compiled output files directly. Sous overwrites them on the next build; edit the
tracked source under `.sous/prompts/` instead.

## Task lists

GFM task lists render with real checkboxes (display only):

- [x] Stand up the docs shell
- [x] Theme it with the `--sous-*` tokens
- [ ] Write the real reference content
- [ ] Add a configuration guide

## Combining

Callouts hold inline markdown too:

?> The **`.tpl.`** convention applies everywhere: files with `.tpl.` in the name render through
LiquidJS, and the marker is stripped from the output name (`agent.tpl.md` becomes `agent.md`).
