---
name: about-sous-documentation
description: >
  YOU MUST load this skill when creating or editing documentation pages for
  the sous website (docs/markdown/), deciding where a new doc page belongs,
  using the docs formatting palette (callouts, term fences, code blocks,
  logo images), or answering where a doc will appear online.
user-invocable: false
---

# About Sous Documentation

Sous's public documentation is plain markdown, rendered live in the browser
by a thin docsify shell. There is no build step and no generated HTML:
committing a markdown file IS publishing it (once merged to `main`, GitHub
Pages serves it).

This skill covers AUTHORING documentation pages. For the shell itself (the
docsify page, its stylesheet, the terminal-demo plugin), read `docs/CLAUDE.md`
before changing anything; it holds the site's rules and pitfalls.

@${sousDir}/prompts/_partials/docs-authoring.md

## Copy rules (site-wide, no exceptions)

- **NEVER use em-dashes** in any copy; semicolons to join clauses, commas or
  parentheses for appositives.
- **NEVER write overconfident predictions about other tools or vendors**
  ("X will never..."). State intent and posture; commitments about Sous's own
  behavior are fine.
- Docs must stay useful as plain markdown files read outside the site (they
  are candidates to ship in the npm package as agent-readable reference), so
  never carry meaning only in images or embedded HTML.

## Current state

Reference content in `docs/markdown/` is written incrementally and directed
by hand; do not write or restructure documentation pages unprompted.

## Local preview

```bash
npx live-server docs --port=8321
```

Then open `http://localhost:8321/markdown/#/`. This auto-reloads on save;
plain `python3 -m http.server` also works but browsers cache its responses
aggressively, which reads as your changes not applying.
