# The Sous Website (`/docs`)

> **GENERATED FILE — DO NOT EDIT `docs/CLAUDE.md` DIRECTLY.**
> This file is compiled by sous (`npm run sous:build`) from
> `.sous/prompts/docs-site/CLAUDE.md`. Edit that source, then rebuild.
> The compiled copy is gitignored; the source is tracked.

**This document records rules, decisions, and pointers; never enumerations.**
If the code already holds a fact (scene lists, token values, CDN pins, file
inventories), point at the code instead of restating it. Hand-maintained
lists rot. Update the source in the same change as any decision-level change
to the site, and delete anything here the code has made false.

## What this site is

GitHub Pages serves this repo's `/docs` directory at
**https://sous-io.github.io/sous/** (repo: `github.com/sous-io/sous`). Two
pages exist:

- `index.html`: a GSAP-driven animated presentation introducing Sous, with
  movie-player controls.
- `markdown/`: the documentation section; markdown files rendered live in the
  browser by docsify. Reference content is written incrementally and directed
  by hand; do not add or restructure pages unprompted.

### Hard constraints

- **Static files only.** No server-side code, no database.
- **No build step for site assets.** Hand-authored HTML/CSS/JS; third-party
  libraries load from CDNs at PINNED versions (the pins live in each page's
  script/link tags), never vendored or npm-installed into the site.
- GitHub Pages runs Jekyll by default; `docs/.nojekyll` keeps it off
  (docsify's `_sidebar.md` would otherwise be swallowed).

### Layout (pointers, not an inventory)

- `docs/css/main.css`: the design system; ALL tokens live in its top block.
- `docs/css/chrome.css`: corner-button chrome shared by both pages.
- `docs/css/presentation.css` + `docs/js/presentation.js`: the presentation.
- `docs/css/docs.css` + `docs/js/term-demos.js`: the docs shell.
- `docs/img/`: the logo pair (`logo-on-white.png`, `logo-on-dark.png`).
- `docs/notes/`: gitignored CLI planning notes; NOT part of the site.

## Design system

- **Every color, font size, font name, spacing value, radius, shadow and
  transition lives in a CSS variable** in the token block at the top of
  `main.css`. Never hard-code a value that belongs in a token; add a token if
  one is missing. Do not restate token values in prose anywhere (including
  here); `main.css` is the palette.
- **Flat bordered tiles, zero shadows.** `.tile` implements the signature
  surface.
- **Green is the only voice of interactivity**: links (no underline),
  primary buttons, focus rings, active states.
- **Do not add granular utility/component classes** until real content
  demands them.
- The dark-mode neutral scale is GitHub's dark palette mapped in reverse over
  the light neutrals, so anything built on `--sous-neutral-*` flips
  automatically. The `--sous-editor-*` tokens are the theme-aware code
  palette (VS Code Light+/Dark+), used by the presentation's code windows,
  the docs' fenced code, and the terminal demos.
- This site deliberately IGNORES `prefers-reduced-motion` (do not re-add
  gating without asking): the animation IS the content, and reduce-motion is
  commonly enabled by OS performance tweaks.

### Theming mechanics

Auto light/dark via `prefers-color-scheme`; forced via
`data-sous-theme="light|dark"` on `<html>`. The toggle persists to
localStorage key `sous-theme`, and an inline `<head>` script re-applies it
before first paint. Every page carries the same pre-paint script and toggle
handler; keep them in sync, and keep the mechanism on every future page.
Theme-paired images use `.logo-light`/`.logo-dark` classes (author both,
CSS shows one per theme).

## Writing rules (ALL site copy and this file)

- **NEVER use em-dashes.** Semicolons to join clauses; commas or parentheses
  for appositives.
- **NEVER write overconfident predictions about other tools or vendors.**
  State intent and posture ("Sous actively tries to..."), not prophecy.
  Commitments about Sous's own behavior are fine. Decision rationale from
  review conversations is input for crafting copy, never copy to paste
  verbatim.

## The presentation

One master paused GSAP timeline is the single source of truth; one child
timeline per scene. Playing = GSAP ticker; paused = an Observer maps
wheel/touch/drag deltas onto a smoothed progress tween (scrubbing). The
chapter bar, time counters, and speed control all render from the timeline.

**Sources of truth (do not duplicate them here):** the `SCENES` array in
`presentation.js` is the scene manifest (ids, groups, bar titles); scene
markup and copy live in `index.html`; the `PROBLEMS`/`PHILOSOPHY` tables in
`presentation.js` generate the problem/philosophy kickers.

### Standing directions

- **Never remove a scene unless explicitly told to**; superseded scenes stay
  in the markup as commented reference.
- **Every problem gets FIVE slides** (Statement, Status-Quo, Mitigation,
  Example, Alternatives; optional Followup after Status-Quo). Problem #1
  (`teams-*`) is the canonical implementation; match it exactly. Alternatives
  slides are titled exactly "Nothing else fills this gap." with tiles stacked
  vertically. Kickers are GENERATED (never hand-written in markup); repeated
  structures become helpers generated in one place.
- **Mitigation prose stays conceptual**: it must not name storage locations
  or config keys (those go stale as Sous evolves). Status-Quo and Example
  slides may keep concrete detail.
- **Iteration workflow:** review happens slide by slide; requested tweaks
  apply to the slide under review and do NOT roll forward until sign-off.
  Reviewed problems are complete, never touch them in rolling updates.
  Exception: shared generated elements (kickers) change everywhere at once
  via their generator.
- The intro logo's desktop size is a deliberate choice; do not shrink it
  without asking.

### Architecture decisions that hold

- Pacing is COMPUTED from scene text by a reading-speed model in
  `presentation.js`; everything scales from the single `baseDelay` knob.
  Tune pacing there, never with per-scene hold numbers (a `SCENES` entry may
  carry an explicit `hold` only as a rare trump card).
- Each scene has `<name>`, `<name>-shown`, and `<name>-exit` labels; UI jumps
  target the `-shown` labels (bare labels land on blank frames).
- The sad/happy effects ("Without Sous" / "With Sous" treatments) are
  inserted into the MASTER timeline at effect boundaries so they scrub; the
  whole system is removable as a unit (fx markup + fx CSS + fx tokens + the
  presentation.js section).
- No autoplay ever; playback starts only from a user gesture. If GSAP's CDN
  fails, `html.no-gsap` leaves the title scene as a static splash.
- Playhead progress and speed choice persist per tab in sessionStorage (for
  hot-reload preview workflows); fresh visitors start at 0.

### Hard-won pitfalls (design these in, do not relearn them)

- Paint-bound CSS animations (background-position, stroke-dashoffset
  keyframes) freeze under window occlusion in Chromium; animate transforms/
  opacity with GSAP instead (this bit both the rain and the diagram dashes).
- `gsap.killTweensOf(tl)` also kills the quickTo smoother's tween; recreate
  the quickTo after every kill.
- Clamp per-tick wheel deltas; trackpads emit momentum events long after
  release, and the smoothing tween must be the only inertia source.
- Multi-line callout highlights need `hl hl-block`; a fragmented inline's
  abspos reference box truncates the highlight background.
- Code windows keep `overflow` visible (tooltips extend past edges), so
  there is NO horizontal scroll: code lines must fit their pane.
- Cloud/FX offscreen offsets are MEASURED from layout at init, never
  hard-coded pixels (fixed offsets strand elements on wide viewports).

## The docs shell (`docs/markdown/`)

A thin client-side shell: **docsify** v4 (pinned; the plugin ecosystem and
DOM contract here are v4-proven; do not bump the major without direction)
renders the markdown in
`docs/markdown/` in the browser. Chosen over hand-rolling marked +
highlight.js because it ships the router, sidebar, and client-side search we
would otherwise own. All CDN pins and `$docsify` config live in
`docs/markdown/index.html`.

@${sousDir}/prompts/_partials/docs-authoring.md

### Shell engineering notes

- NO stock docsify theme is loaded; `docs.css` styles docsify's bare DOM
  directly from tokens, so both themes flip automatically. The article's
  vertical rhythm is set by `--sous-docs-rhythm` in `docs.css` (looser than
  the compact admin base). Headings have NO underline rules; do not add
  any.
- Terminal demos: the engine is termynal (MIT, pinned CDN); the ```` ```term ````
  fence conversion and play-on-scroll are OUR glue in `docs/js/term-demos.js`.
  Never give a demo container the `.termy` class (termynal auto-plays those
  at script load).
- The sidebar app name is the theme-paired logo (docsify injects the `name`
  config as HTML). Sidebar visibility rules and the logo swap share
  specificity carefully; see the comments in `docs.css` before touching them.
- Corner chrome is shared via `chrome.css` (right-anchored slot classes).
  The presentation links to the docs via its top-left "Documentation" text
  link and the intro's "... or, jump straight into the docs." line; the docs
  page links back with a play-circle icon.
- Docsify quirk: `!>` emits `p.tip` and `?>` emits `p.warn`; our CSS styles
  them correctly despite the backwards names.

## Working on the site

- Local preview: `npx live-server docs --port=8321` (auto-reload; plain
  `python3 -m http.server` works but browsers cache its responses
  aggressively, which reads as your changes not applying).
- The site's HTML/CSS/JS under `docs/` is hand-written and tracked normally.
  The ONLY sous-generated file in `docs/` is this CLAUDE.md.
- The repo-root `CLAUDE.md` covers the Sous CLI; this file covers only the
  website. Both are sous-generated from tracked sources under
  `.sous/prompts/`.

@${sousDir}/prompts/_partials/sources-of-truth.md
