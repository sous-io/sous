# Review note template

This file is a template, so the build renders it and drops `.tpl.` from its
name. Two things are worth reading here.

First, what a template can see. A template reads the project's own config
variables, including the ones sous provides:

- Built by sous version {{ sousVersion }}.
- Rendered from {{ sousTemplateDir }}.

The answers this recipe asked for are a different system: they are stored in the
project's env files, and `sous vars list` is what shows them. A template never
reads them directly.

Second, the lines below come from a sibling recipe, included through the reserved
sigil, which proves that a recipe can read the files of something it depends on.

@~workflow/qa-helper/_partials/review-steps.md
