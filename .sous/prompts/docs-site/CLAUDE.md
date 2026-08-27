# The Sous Website (`/docs`)

> **GENERATED FILE — DO NOT EDIT `docs/CLAUDE.md` DIRECTLY.**
> This file is compiled by sous (`npm run sous:build`) from
> `.sous/prompts/docs-site/CLAUDE.md`. Edit that source, then rebuild.
> The compiled copy is gitignored; the source is tracked.
>
> **Agents must ACTIVELY maintain the source file.** As the site's design and
> implementation evolve — new pages, new tokens, presentation scenes, changed
> decisions — update `.sous/prompts/docs-site/CLAUDE.md` in the same change,
> exactly as the root CLAUDE.md is maintained for the CLI. This document must
> always describe the site accurately.

## What this site is

- GitHub Pages serves the `main` branch's `/docs` directory at
  **https://sous-io.github.io/sous/** (repo: `github.com/sous-io/sous`).
- **Today:** the main page is a GSAP-driven animated *presentation* introducing
  Sous, with movie-player controls (see "The presentation" below), plus a
  **documentation section** at `/docs/` (see "The docs shell" below): markdown
  files rendered live in the browser by docsify. The shell is real; its pages
  are currently EXAMPLE placeholders, and the actual reference content is
  future work Luke will direct by hand (gh-8 covered the shell only).

### Hard constraints

- **Static files only.** No server-side code, no database.
- **No build step for site assets.** Hand-authored HTML/CSS/JS. Third-party
  libraries are loaded from CDNs (jsdelivr/cdnjs/unpkg) — never vendored via a
  bundler, never `npm install`-ed into the site.
- GitHub Pages runs Jekyll by default; if an underscore-prefixed directory is
  ever added under `docs/`, add an empty `docs/.nojekyll` file.

## Files

| File | Role |
|------|------|
| `docs/index.html` | The presentation page: scene markup (one `<section class="scene" data-scene="…">` per scene), player controls, the light/dark toggle, GSAP CDN script tags. Scene text distilled from `docs/notes/SOUS-GOALS.md`. |
| `docs/.nojekyll` | Empty; keeps GitHub Pages' default Jekyll pass off the site (it would otherwise swallow docsify's `_sidebar.md`). |
| `docs/docs/` | The docs shell: `index.html` (docsify mount, CDN pins, corner chrome) plus the markdown content itself (`README.md` home, `_sidebar.md` nav manifest, `example-*.md` pages). |
| `docs/css/main.css` | The design-system stylesheet: all tokens, base element styles, minimal foundational classes. |
| `docs/css/chrome.css` | The shared corner-button chrome (`.repo-link`, `.npm-link`, `.theme-toggle`, slot classes), used by BOTH pages. Extracted from presentation.css when the docs shell landed. |
| `docs/css/presentation.css` | Page + player styles for `index.html` (stage, scenes, control bar, chapter segments, theme toggle). Everything references `--sous-*` tokens. |
| `docs/css/docs.css` | The docs-shell stylesheet: docsify layout/sidebar/search styling, article typography/rhythm rules, the Prism token theme, termynal overrides. Styles docsify's BARE DOM (no stock theme). |
| `docs/js/term-demos.js` | Site-owned docsify plugin: converts ```` ```term ```` fences into termynal markup and plays each demo on first scroll-into-view. |
| `docs/js/presentation.js` | The presentation logic (vanilla JS IIFE): master timeline, scene builds, Observer scrubbing, chapter bar, keyboard controls, FX (banners/sky/rain), pacing model. |
| `docs/img/logo-on-white.png` | The Sous logo (chef's hat + wordmark, 1254×1254, transparent bg). Drawn for white/LIGHT backgrounds — a dark-mode variant is still being designed (source of truth: `~/GoogleDrive/Projects/Sous.io/media/`). Used in the intro scene, sized by `.scene-logo` (`clamp(8rem, 48vh, 32rem)`; 32rem is Luke's preferred size on his desktop viewport — do not shrink it without asking). |
| `docs/CLAUDE.md` | This generated file. |
| `docs/notes/` | Gitignored planning notes for the CLI project — NOT part of the site. |

## Design system

Adapted from the **BTCPay Server Design System** (https://design.btcpayserver.org,
MIT), re-prefixed `--btcpay-*` → `--sous-*`. Luke specifically likes the
BTCPayServer 1.x settings-UI vibe; research confirmed 2.x kept the same theme
(only navigation/layout changed), so this system reflects both.

### Rules

- **Every color, font size, font name, spacing value, radius, shadow and
  transition lives in a CSS variable** in the token block at the top of
  `docs/css/main.css`. Never hard-code a value that belongs in a token; add a
  token if one is missing.
- **Do not add granular utility/component classes yet.** Content comes first;
  classes are added when real content demands them (Luke's explicit direction).
  Current foundational classes: `.container`, `.tile`, `.text-muted`, `.btn`,
  `.btn-primary`, `.btn-secondary`.

### Core palette

| Token | Value | Role |
|-------|-------|------|
| `--sous-brand-primary` | `#51b13e` | Signature green — links, buttons, focus, active states |
| `--sous-brand-tertiary` | `#1e7a44` | Hover/accent green |
| `--sous-brand-secondary` | `#cedc21` | Lime accent (use sparingly) |
| `--sous-brand-dark` | `#0f3b21` | Deep forest green |
| Light: body bg | `#f8f9fa` | Neutral-100 |
| Light: text | `#292929` | Neutral-900 (warm near-black) |
| Light: borders | `#e9ecef` / `#dee2e6` | light / medium |
| Dark: body bg | `#161b22` | GitHub-dark; tiles/surfaces `#0d1117`, borders `#21262d`/`#30363d` |
| Semantic | info `#17a2b8`, warning `#ffc043`, danger `#e11900`, success = brand green | Each has a 100–900 scale + "dim" bg/text pairs |

The dark-mode neutral scale is GitHub's dark palette, remapped in *reverse*
over the light neutrals, so anything built on `--sous-neutral-*` flips
automatically.

### Typography

- **Open Sans** (Google Fonts `@import`, weights 400/600/700), fallback
  Helvetica Neue/Arial; mono = SFMono/Menlo/Consolas stack.
- **14px base** (`0.875rem`), line-height 1.6 — the compact admin feel.
- Weights: 400 body, **600 semibold** (nav, labels, buttons — used heavily),
  700 bold headings (line-height 1.2).
- Size tokens: xs 10 / s 12 / m 14 / l 18 / xl 36 / xxl 45 px. Headings h1–h6:
  35 / 28 / 24.5 / 21 / 17.5 / 14 px.

### Style principles (the "vibe")

1. **Flat bordered tiles, zero shadows** — surfaces are `--sous-bg-tile` with
   8px radius and a 1px `--sous-border-medium` border. `.tile` implements this.
2. **Green is the only voice of interactivity** — links (no underline), primary
   buttons (hover `#1e7a44`), focus rings (`--sous-focus-ring`), active states.
3. Spacing scale 4/8/16/32/64/80px (`--sous-space-*`); transitions 0.2/0.3/0.5s.
4. Subtle motion only. NOTE: this site deliberately IGNORES
   `prefers-reduced-motion` (Luke's direction, 2026-08-14; do not re-add
   gating without asking). Rationale: the animated presentation IS the
   content, and reduce-motion is commonly enabled by OS performance tweaks
   rather than user intent.

### Theming mechanics

- Auto light/dark via `prefers-color-scheme`; forced via
  `data-sous-theme="light|dark"` on `<html>`.
- The toggle persists to localStorage key **`sous-theme`**; an inline `<head>`
  script re-applies it before first paint (no flash). Both pages
  (`index.html` and `docs/docs/index.html`) carry the same pre-paint script
  and toggle handler. Keep this mechanism on every future page.

## The docs shell (implemented; gh-8)

The documentation section lives at `/docs/` (repo path `docs/docs/`; the outer
`docs/` is just the GitHub Pages site root). It is a thin client-side shell:
**docsify** fetches the markdown files in `docs/docs/` and renders them in the
browser. Publishing a page = commit one markdown file + one `_sidebar.md`
line; there is no build step and no generated HTML, which is exactly the site's
hard constraint. Chosen over hand-rolling marked + highlight.js because it
ships the router, sidebar, and client-side search we would otherwise own;
VitePress-style chrome was the runner-up styling reference.

### Stack (all pinned CDN URLs in `docs/docs/index.html`)

- **docsify 4.13.1** + its bundled Prism, plus grammar components from
  `prismjs@1.30.0` (bash, json, yaml, typescript, markdown,
  markup-templating + liquid). docsify 5.0.0 exists but the plugin ecosystem
  and DOM contract here are v4-proven; upgrading is a deliberate future task.
- **Plugins:** `search` (ships with docsify), `docsify-copy-code@3.0.0`,
  `docsify-pagination@2.10.1`.
- **termynal** (`termynal/termynal.py@v0.14.0` on jsdelivr, MIT): the animated
  terminal engine. `docs/js/term-demos.js` is OUR glue (not a library):
  a docsify plugin whose `beforeEach` converts ```` ```term ```` fences into
  termynal containers and whose `doneEach` arms an IntersectionObserver that
  calls `Termynal.init()` on first visibility (constructed `noInit: true`).
  Do NOT give demo containers the `.termy` class; termynal.js auto-plays
  those at script load.

### Config and conventions

- `window.$docsify`: `loadSidebar: true`, `subMaxLevel: 2` (the active page's
  h2s nest under it in the sidebar), `auto2top`, `executeScript: true`.
- `_sidebar.md` must stay a TIGHT list (no blank lines between items):
  loose lists make docsify wrap links in `<p>`, which breaks the active-item
  CSS (both shapes are styled, but keep it tight anyway). Non-link items
  (`- **Examples**`) render as uppercase muted section labels.
- ```` ```term ```` fence line syntax (docs on the example-terminal page):
  `$ ` typed input, `// ` subtle comment, `>> ` progress bar, blank = spacer,
  anything else = output. The transform only matches fences at COLUMN 0, so an
  indented ```` ```term ```` block renders literally; that is how the
  authoring page documents the syntax, and it must stay indented.
- **Theming:** no stock docsify theme is loaded; `docs/css/docs.css` styles
  the bare DOM from `--sous-*` tokens, so both themes flip automatically.
  Fenced code AND the terminal demos use the theme-aware `--sous-editor-*`
  palette (same as the presentation's code windows; `--sous-editor-number`
  was added for Prism), so terminals read as light editor windows on the
  light theme (always-dark terminals looked imposing on white; Luke's
  direction 2026-08-27), green `$` prompts in both.
  The article's vertical rhythm is MUCH looser than the compact admin base:
  `--sous-docs-rhythm` (32px, defined in docs.css) spaces the article blocks,
  h2 gets `--sous-space-xl` above (h3/h4 1.5x `--sous-space-l`), and
  sidebar/table/code paddings are similarly widened (same direction, same
  date); keep new docs styles on that rhythm, not the presentation's tighter
  one. Headings have NO underline rules (removed at Luke's direction; do not
  re-add the GitHub-style h1/h2 border-bottom).
  Logo images in doc pages use the same `.logo-light`/`.logo-dark` theme-swap
  pattern as the presentation's intro logo (author BOTH `<img>`s; docs.css
  scopes the swap to `.markdown-section`).
  Docsify callout helpers: `!>` renders `<p class="tip">` styled as IMPORTANT
  (danger dim pair); `?>` renders `<p class="warn">` styled as a NOTE
  (info dim pair). The class names are docsify's, and they read backwards;
  the styling is ours and is correct.
- **Corner chrome:** the docs page reuses `css/chrome.css` with, right to
  left: npm (slot 1), GitHub (2), theme toggle (3), and a play-circle link
  back to the presentation (`.pres-link`, slot 4). The presentation links
  HERE via its top-left "Documentation" text link and the intro's
  "... or, jump straight into the docs." line. Same `sous-theme` pre-paint +
  toggle scripts as the presentation; keep them in sync.
- The `example-*.md` pages are PLACEHOLDERS demonstrating shell features
  (typography, code highlighting, callouts/tasks, routing/search, terminal
  demos). Luke will direct the real reference content by hand; do not start
  writing real docs unprompted.
- Local preview: `python3 -m http.server` from `docs/`, then
  `http://localhost:8000/docs/#/`.

## The presentation (implemented)

The main page is an animated, movie-like presentation with player controls,
built exactly on the researched architecture below (first milestone: mechanics
over spectacle — simple fade/slide scene transitions).

### Requirements (all implemented)

1. A **play button** starts an auto-playing sequence of animations (a prominent
   "Play the introduction" button on the title scene, plus a play/pause button
   in the bottom control bar).
2. **Pause** freezes exactly in place, mid-animation.
3. While paused, the **scroll wheel scrubs** the presentation forward/backward
   (also touch/pointer drag; also before the first play).
4. A bottom **timeline bar** shows named **"scenes"** and supports jumping
   between them (segment widths proportional to scene duration, per-segment
   progress fill, `aria-current` highlight), plus an
   `<input type="range">` scrub slider above the segments.

### The five-slide problem pattern (Luke's direction, 2026-08-13)

EVERY problem gets FIVE slides (Problem #1 / `teams-*` is the canonical
implementation; match it exactly):

1. **Statement** — the problem and why it exists; text only.
2. **Status-Quo** — the pain WITHOUT Sous; usually one or more code windows.
3. **Mitigation** — how Sous mitigates it; usually an animated diagram.
4. **Example** — the fix demonstrated; usually one or more code windows.
5. **Alternatives** — why others don't fill the gap, as tiles: (a) AI Coding
   Agents (why claude-code/codex etc. don't), (b) Similar Tools where
   applicable, and (c) **Discipline** for many/most problems (why "just be
   careful" is hard or impossible). Two conventions are APPROVED and apply to
   every alternatives slide: the title is exactly **"Nothing else fills this
   gap."**, and the tiles **stack vertically** in one centered column
   (`class="scene-grid scene-grid-stack"`), never side by side.

Every problem slide's kicker stacks TWO centered lines: `Problem #<x> (pill)`
/ `<Brief In Title Case>`. The pill is one of five types (`.pill.pill-<type>`:
`Statement`, `Status-Quo`, `Mitigation`, `Example`, `Alternatives`) but all
five are styled IDENTICALLY and unobtrusively: transparent background, padding
`0 --sous-space-s` (no vertical padding; the inherited line-height provides
the height), 1px `currentColor` border, inheriting the kicker's green. The `pill-<type>` classes stay on the markup for future
styling hooks; do not color-vary them without direction. The brief is IDENTICAL across a
problem's five slides. Scene ids: `<problem>-statement`,
`<problem>-status-quo`, `<problem>-mitigation`, `<problem>-example`,
`<problem>-alternatives`.

**The kicker is GENERATED, not hand-written.** `buildProblemKickers()` in
presentation.js holds the `PROBLEMS` table (num + brief per problem) and
`SLIDE_TYPE_LABELS`, derives problem/type from each `data-scene` id, and
prepends the kicker to `.scene-inner`. Do NOT add kicker markup to problem
sections in index.html; to change the heading's format or text, edit the
builder/table (and `.kicker-problem` CSS, which tightens letter-spacing to
0.12em because these kickers carry a whole sentence). Prefer this pattern:
repeated structures become helpers generated in one place.

Luke refers to these as "#<x> <type>" (e.g. "#1 statement") and uses
"slide" and "scene" interchangeably.

**Optional sixth type: Followup** (`<problem>-followup`, pill "Followup",
opt-in per problem; inserted after Status-Quo). Problem #1's is the canonical:
a Matrix-style typer (GSAP TextPlugin, loaded from the same CDN) types two
scene-title lines with a hopping blink cursor, then a code box and a lead
BELOW it rise in. Its late elements are NOT `.anim` (the `followupTimeline`
extra choreographs them; they carry `.followup-reveal` and `.scene-exit`,
the latter so `sceneOut` clears non-.anim elements too). Followups keep the
SAD effect.

**Iteration workflow:** Luke reviews problem by problem, slide by slide.
Changes he requests apply immediately to the slide under review. Do NOT roll
them forward to later problem slides until he has signed off on the tweak;
sign-off may simply be him moving on to the next thing. Then propagate via a
background agent. Problems already reviewed are COMPLETE; never touch them in
rolling updates. EXCEPTION: shared formatting elements (like the generated
problem kicker) are uniform across all slides by definition; format changes to
those apply everywhere at once, ideally by editing their single generator.

### Scenes (in order; label name = `data-scene` attr in `index.html`)

| Label | Bar title | Content |
|-------|-----------|---------|
| `intro` | Intro | Title scene: logo, "Your coding agent's assistant", tagline, `$ npm install -g @sous-io/sous` prompt motif, big play button ("Play the Introduction", Title Case) with a "... or, jump straight into the docs." link (`.intro-docs`, to `docs/#/`) beneath it. Visible statically before play (and if JS/GSAP fails). Pressing play skips the rest of the intro hold and transitions away immediately (the user has already consumed the static scene). |
| `features` | Core Systems | The two core systems as tiles with Lucide icons: Config Aggregation (`combine`) + Liquid Templates (`braces`); tagline "It's a bit like [Helm](https://helm.sh), but for AI coding tools." |
| `aggregator` | Aggregator | Core system #1 explained: inline-SVG orbit diagram; six same-size circles (Project/Department/Company/Personal/2× Public Repo, two-line labels, r=48) orbit a central "Project" circle, green dashed flow lines (marching-dash movement driven by a single GSAP loop in presentation.js; the old CSS stroke-dashoffset keyframe was paint-bound and froze on some machines) with arrowheads pointing inward. All colors from tokens. |
| `templates` | Templates | Core system #2 explained as SUB-SCENES in one `.code-stack` (two VS Code-style windows overlapping in one grid cell; `--sous-editor-*` tokens are THEME-AWARE: Light+ palette in light mode, Dark+ in dark mode): first the `SKILL.tpl.md` template (YAML frontmatter, `{{ projectRoot }}` injection, `{% if tool %}` claude-code/codex branch about HOW TO APPLY EDITS deliberately unrelated to the glob, fictitious `{% globDirectory dir="{{ projectRoot }}/src/models" pattern="**/*Model.ts" %}`) with its callout walkthrough, then a crossfade to the rendered `SKILL.md` window (full skill output, fictitious absolute `/projects/backend/src/models/...` paths, one nested under `billing/` proving the `**`) with its single callout on the injected path list ("Absolute paths, sourced from the project, never stale. This will save your agent dozens of steps in every relevant session."). Sequenced by `templatesTimeline` in presentation.js. Hand-highlighted with `tok-*` spans; code font is `--sous-font-size-base`. |
| `why` | Why? | Kicker "The Motivation", h2 "But, Why?": Sous fills a few gaps that AI coding harnesses don't, and likely won't, because those problems scale across multiple providers; segue into the seven problems, five slides each. |
| `teams-statement` | Reusability | P1 slide 1 (Statement): the MERGED problem (old P1-P3); brief "Configs Don't Travel", h2 "Tool configs have a *reusability* problem.", leads: instructions unavoidably collect developer/environment/project/team/tool specifics; reuse forks and diverges. Text only. |
| `teams-status-quo` | Reusability: Today | P1 slide 2 (Status-Quo): h2 "Same skill, different everything."; two panes diverging on ALL THREE axes at once: tabs `.claude/...` vs `.codex/...` (tool), paths `/Users/alice/dev/api` vs `/home/bob/proj/webapp` (machine + project), closing lines Edit tool vs apply_patch (dialect). |
| `teams-followup` | Reusability: Followup | P1 followup: typed "I know what you're thinking..." / "... just make your skills generic, right?", then a code window (`skills/write-code/SKILL.md`: "Write code good." / "Make it look like the other stuff we wrote, but better.") and below it the lead about generic files merging into the system prompt (vague suggestions; ignored or filled with wrong decisions). |
| `teams-mitigation` | Reusability: Sous | P1 mitigation (MERGED problem): h2 "Variables carry the *differences*."; `.flow-diagram` SVG, two top-to-bottom flows (Alice's variables `alice · api · claude` → Sous → `.claude/skills/ (api)`; Bob's `bob · webapp · codex` → Sous → `.codex/skills/ (webapp)`) with the shared `SKILL.tpl.md` box centered between the Sous boxes; the same cast/axes as the status-quo panes, un-forked. Conceptual copy. |
| `teams-example` | Reusability: Demo | P1 slide 4 (Example): h2 "The template asks; the context answers."; shared `SKILL.tpl.md` (`{{ devRoot }}/{{ project }}` path + `{% if tool %}` branch) next to a `.sous/ (Alice's values)` pane showing values layered across `.env.local` (DEV_ROOT) and `sous.config.js` (project, tool). |
| `teams-alternatives` | Reusability: Alts | P1 slide 5 (Alternatives): stacked tiles; AI Coding Agents (`bot`), Similar Tools (`package`), Discipline (`shield-check`, repointed to hand-syncing forks since the Followup slide owns the "just make it generic" argument). |
| `tokens-statement` | Tokens | P2 slide 1 (Statement): "Wasted tokens buy you a distracted agent"; compaction, then inattention, plus re-run discovery every session. Text only. |
| `tokens-status-quo` | Tokens: Today | P2 slide 2 (Status-Quo): two side-by-side code windows; a `SKILL.md` that says "run these first" next to the same three commands re-run in every new session (~1,400 tokens before any work). |
| `tokens-mitigation` | Tokens: Sous | P2 slide 3 (Mitigation): `.flow-diagram` SVG (`tokensFlowArrow`), a 3-box vertical chain: "Your project" (`flow-src`, `src/**/*.ts`) down through "Sous" (`flow-engine`, "helpers run once") to "Agent context" ("0 commands"). |
| `tokens-example` | Tokens: Demo | P2 slide 4 (Example): single `.code-window` (one-pane `.code-stack`): `{{ gitBranch }}` + a `globDirectory` helper, with a dim comment showing what the build renders them into. |
| `tokens-alternatives` | Tokens: Alts | P2 slide 5 (Alternatives): stacked tiles; AI Coding Agents (`bot`, caching makes context cheaper, not unnecessary), Callable Scripts (`terminal`, a step plus the full output in context), Discipline (`shield-check`, nobody re-optimizes context by hand each session). |
| `stale-statement` | Stale | P3 slide 1 (Statement): "A written list is wrong within a week"; agents default to embedding lists in skills (you have to stop them), and every list starts rotting immediately. Text only. |
| `stale-status-quo` | Stale: Today | P3 slide 2 (Status-Quo): two side-by-side code windows; the entity list written into `SKILL.md` in March next to `src/entities` today (two new, one gone). |
| `stale-mitigation` | Stale: Sous | P3 slide 3 (Mitigation): `.flow-diagram` SVG (`staleFlowArrow`); "The code" (`src/entities/*.ts`) flows down through the `flow-engine` Sous box ("every build"), out to the entity skill, core memory, and a review bot's prompt. |
| `stale-example` | Stale: Demo | P3 slide 4 (Example): single `.code-window`: `globDirectory` over `src/entities` plus the always-current rendered list as a dim comment. |
| `stale-alternatives` | Stale: Alts | P3 slide 5 (Alternatives): stacked tiles; AI Coding Agents (`bot`, writes the list once and never re-reads), Callable Scripts (`terminal`, only if the agent runs it; the stale list still reads as truth), Discipline (`shield-check`, a hand-maintained list will go stale). |
| `speed-statement` | Speed | P4 slide 1 (Statement): "Agents spend their first minutes relearning the obvious"; every info-gathering command is a round trip, AND it is not just session start: most tasks begin the same way, so a huge share of agent time goes to relearning the basics. Text only. |
| `speed-status-quo` | Speed: Today | P4 slide 2 (Status-Quo): single `.code-window`; the first 40 seconds of a session, five discovery commands in a row and no code changed yet. |
| `speed-mitigation` | Speed: Sous | P4 slide 3 (Mitigation): the delegation-ladder `.flow-diagram` SVG (`speedFlowArrow`), a 5-rung descending staircase (240×48 boxes stepping down-right in a `0 0 640 412` viewBox): Fable 5 → Opus → Sonnet → Haiku → "Plain code" (`flow-engine`, "$0, milliseconds"). Two leads: zero-reasoning work delegates past models to plain code (a Sous helper), and just-in-time context (the api-clients skill story; path + description of every client, zero steps wasted). |
| `speed-example` | Speed: Demo | P4 slide 4 (Example): side-by-side code windows; a model file's doc block with the team's `@summary` convention next to `skills/models/SKILL.tpl.md` using a home-grown `{% fileSummaries %}` helper, with the rendered path+summary list as a dim comment. |
| `speed-alternatives` | Speed: Alts | P4 slide 5 (Alternatives): stacked tiles; AI Coding Agents (`bot`, parallel calls make round trips cheaper, not unnecessary), Callable Scripts (`terminal`, scripts work but each call is a round trip and a decision; Sous saves the step, helpers are cross-platform and as sophisticated as you want), Discipline (`shield-check`, "don't explore" just means it guesses). |
| `docs-statement` | Docs | P5 slide 1 (Statement): "The same fact lives in five files"; per-directory CLAUDE.md/AGENTS.md docs are great, so they multiply; facts repeat briefly in central docs and fully next to the code, and only one copy gets updated. Text only. |
| `docs-status-quo` | Docs: Today | P5 slide 2 (Status-Quo): two side-by-side code windows; the root `CLAUDE.md` still says invoices generate nightly (written in March) next to `src/billing/CLAUDE.md` saying hourly (updated in May, with the code). |
| `docs-mitigation` | Docs: Sous | P5 slide 3 (Mitigation): `.flow-diagram` SVG (`docsFlowArrow`); "The billing doc" (`docs/billing.md`) flows down through the `flow-engine` Sous box, out to the root `CLAUDE.md`, `src/billing/CLAUDE.md`, and `AGENTS.md`. |
| `docs-example` | Docs: Demo | P5 slide 4 (Example): side-by-side code windows; a source `prompts/CLAUDE.md` with an `@${docsRoot}/billing.md` include (Claude Code's @-import format, but resolved at build time with variables in the path) next to a `sous.config.js` `outputs` array writing one render to two `destinationFile`s (`CLAUDE.md` + `AGENTS.md`). |
| `docs-alternatives` | Docs: Alts | P5 slide 5 (Alternatives): stacked tiles; AI Coding Agents (`bot`, they read nested docs wonderfully but nothing maintains them or propagates shared content between doc files), Similar Tools (`package`, they move one file to one place; nothing composes a single source into many destinations), Discipline (`shield-check`, updating every copy of a fact in the same commit is the thing people reliably fail to do). |
| `philosophy-augment` | Augment | Principle #1: augment, don't compete; when a tool can do it natively, do it natively; Sous is for what it can't. |
| `philosophy-collective` | The Gaps | Principle #2 (Luke's own wording): Sous actively tries to avoid competing with any tool, especially any class of tools; instead it tries to fill the COLLECTIVE gaps that most or all tools either can't or won't fill. |
| `philosophy-unopinionated` | No Opinions | Principle #3: h2 "Be a *tool*, not a *framework*." (both words em'd; imperative voice matching the other principle titles); AVOIDS FORCING opinions (not "has none"); beyond the few core skills that teach agents to work with Sous (config dir is generated, how to edit sous skills), all built-ins are opt-in only, and even the core is opt-out-able. |
| `philosophy-enter` | Easy In | Principle #4: h2 "Be easy to *enter*."; copies plain files just like it renders templates; marketplaces/installers still work, pointed at a Sous repo or `.sous`. |
| `philosophy-exit` | Easy Out | Principle #5: h2 "Be easy to *exit*."; commit the built configs and delete `.sous`; playful "we know you'll miss it ;)" kept deliberately. |
| `outro` | Get Started | h2 "Ready, when you are."; logo reprise (smaller `.scene-logo`), `$ npm install -g @sous-io/sous` motif (matches the intro, incl. its prompt margins), side-by-side `.btn-row` CTAs ("GitHub →" primary, "NPM →" secondary). Gets the HAPPY effect (blue sky, clouds, orb, With Sous ribbon). Stays on screen at the end. |

Philosophy-slide kickers are GENERATED like problem kickers: the `PHILOSOPHY`
array + `buildPhilosophyKickers()` in presentation.js emit one line,
"Principle #<n>" with a `(Philosophy)` pill (`.pill.pill-philosophy`) to its
right. Do not hand-write kicker markup on philosophy slides.

**Retired scenes.** `what` ("What is Sous"), `problems` ("The Problems" 2×2
grid) and `how` ("How It Works" 2×2 grid) are RETIRED from the flow, replaced
by the `why` scene and the five-slide problems. Their `<section>`
markup stays in `index.html` for reference (comments marked "RETIRED from the
flow, kept for reference"), but they have no `SCENES` entries, so the base
`.scene` CSS (opacity 0 / visibility hidden) keeps them off screen. The old
`non-goals` scene ("A tool, not a framework") was fully DELETED at Luke's
direction after being split into the six philosophy scenes.

**Problem-slide anatomy.** All five problems run on the five-slide pattern (Problems 1-3 were MERGED into #1 "Configs Don't Travel" on 2026-08-14; their slide sets were deleted, best material salvaged into #1)
above; there are no `<problem>`/`<problem>-sous` pairs left. Holds are COMPUTED
from each slide's content (see "Pacing" below); no per-slide hold numbers to
manage.
Statement slides are text-only (kicker, punchy h2, two `.lead` paragraphs).
Status-Quo and Example slides use code windows: two side-by-side
`.code-window`s inside a `.scene-grid`, or a single full-width window in a
one-pane `.code-stack`. **Code lines in a half-width pane must stay under ~26
characters** (the panes are ~39 mono characters wide and code windows have NO
horizontal scroll); full-width windows tolerate ~60. Mitigation slides use a
`.flow-diagram` SVG or comparison tiles. Alternatives slides are three
`.tile.scene-card`s stacked in a `.scene-grid.scene-grid-stack`, all titled
"Nothing else fills this gap.": AI Coding Agents (`bot`), then either
Similar Tools (`package`, for the `npx skills`/marketplace argument) or
Callable Scripts (`terminal`, the right comparison for tokens/staleness/speed),
then Discipline (`shield-check`).

Flow diagrams share the `.flow-diagram` / `.flow-lines` / `.flow-node` /
`.flow-src` / `.flow-engine` / `.flow-path` classes in `presentation.css` (flat
token-colored boxes, green dashed lines whose marching motion comes from the
shared GSAP dash loop in presentation.js); each
SVG defines its OWN arrow-marker
id (`teamsFlowArrow`, `projectsFlowArrow`, `toolsFlowArrow`, `tokensFlowArrow`,
`staleFlowArrow`, `speedFlowArrow`, `docsFlowArrow`; ids are document-global, never reuse one) referenced via
`marker-end` attributes on the lines, not CSS.

**Flow-diagram conventions (approved on P1, 2026-08-13; apply to every one).**
They read **top to bottom**: inputs on the top row, outputs on the bottom row,
never left to right. **Sous is visible in the pipeline** as a solid-green
`.flow-node.flow-engine` box (white label) on the middle row, so the diagram
shows the transformation instead of a bare fan-out. Spacing is compact and
uniform: 64-unit-tall boxes on rows at `y=20` / `y=147` / `y=274` (63 units of
gap), lines leaving a box 4 units below it and stopping 8 units above the next,
in a `0 0 640 358` viewBox. `speed-mitigation` deviates deliberately: it is the
delegation ladder, a 5-rung staircase descending down-right (not the 3-row grid),
though it keeps the shared classes, marching-dash arrows and its own marker id.
Diagram box labels may name concrete
files/paths (`.flow-path`); the slide's prose may NOT (see below).

**Mitigation prose stays conceptual.** A mitigation `.lead` must not name
storage locations or config keys (`.env.local`, `_vars`, `sous.config.js`);
those details go stale as Sous evolves. Say "values live outside the templates",
"per-project variables". Status-Quo and Example slides, being demonstrations,
may keep concrete detail.

The problem slides carry NO `.hl` callouts/tooltips yet; Luke will direct those
later.

### Working rules for scene work (Luke's direction, 2026-08)

- **NEVER use em-dashes in copy.** Use semicolons to join clauses, commas or
  parentheses for appositives. This applies to ALL text on the site.
- **NEVER write overconfident predictions about other tools or vendors** ("no
  tool will ever...", "vendors will never want..."). State intent and posture
  ("Sous actively tries to..."), not prophecy. Commitments about Sous's own
  behavior are fine. Also: Luke's decision-making rationale is input for
  crafting user-facing principles, not copy to paste verbatim.
- **Never remove a scene unless explicitly told to** — superseded scenes stay
  for reference and ideas. When Luke describes a slide unlike any existing
  one, INJECT a new scene at the position being described.
- **Lean into animated charts and diagrams** (and eventually code snippets) —
  the presentation should be visual, not text tiles forever.
- **The chapter bar is GROUPED** (solved 2026-08-13): two rows below the scrub
  slider. The top row shows scene GROUPS (Intro, one per problem, Philosophy,
  End); the bottom row shows only the ACTIVE group's scenes and re-renders when
  the playhead crosses into a new group. Segments are EQUAL WIDTH in both rows
  (Luke's direction; duration-proportional widths caused ellipsis). Each `SCENES` entry carries a `group`
  string and a group-relative `title` (problem scenes: Statement / Today /
  Sous / Demo / Alts, generated by `problemScenes()`). Clicking a group jumps to its first
  scene's `-shown` label.
- **Elapsed / remaining time counters** (`m:ss`, no captions) flank the scrub
  slider (`#timeElapsed` / `#timeRemaining`), fed from `tl.time()` /
  `tl.duration()` in `syncUi`, DIVIDED by the current `timeScale` so the
  counters show wall-clock time at the selected speed (2x halves the
  remaining time); `setSpeed()` calls `syncUi()` so they refresh instantly.
- **The sad/happy effects** ("commercial" treatment; Luke's naming):
  statement and status-quo slides get the SAD effect: the stage desaturates to black and
  white (a `--fx-gray` CSS var on `.stage` drives `filter: grayscale()`;
  GSAP animates the var) and a dark "Without Sous" corner ribbon flies into
  the bottom-right. Mitigation and EXAMPLE slides get the HAPPY effect: color
  returns, a blue "With Sous" ribbon flies in, and an ambient sky
  (`.fx-sky`: a soft orb that is a sun in light mode / silvery moon in dark
  via the `--sous-fx-*` tokens, plus three slowly drifting CSS clouds)
  enters behind the scene: the `.fx-sky-tint` fades in (light mode: bright
  blue-tinted sky gradient, dark enough for WHITE clouds to read but never
  enough to hurt text contrast; dark mode: deep night-blue tint), the clouds
  FLY in from their nearest screen edge (offscreen offsets are MEASURED from
  layout at init, never hard-coded pixels: the wrappers sit at percentage
  positions, so fixed offsets strand clouds on wide viewports), and the orb
  enters from the lower right along an arc (different eases on x and y bend the path), reversing on
  exit. The SAD effect adds gloom: faint diagonal rain (`.fx-rain`; ~75
  JS-built drop divs in two depth layers inside a once-tilted
  `.fx-rain-drops` wrapper, each tweened by GSAP on `y` only with
  `repeat: -1` and randomized phase; `syncUi` pauses the loops while the layer is invisible. Do NOT reimplement with CSS `background-position` animation:
  it is paint-bound, Chromium throttles it under window occlusion, and it
  reads as scrolling texture instead of rain. Transform/opacity only.), an edge vignette
  (`.fx-gloom`, above the scenes), and a slight dim that rides `--fx-gray`
  in the `.stage` filter (`brightness(calc(1 - var(--fx-gray) * 0.07))`). All other slides clear both effects. Transitions are inserted into
  the MASTER timeline at each effect boundary (`effectFor()` /
  `fxTransition()` in presentation.js), so they scrub correctly. Ribbons live
  INSIDE `.stage` (clipped by it, and the happy ribbon regaining saturation
  as `--fx-gray` animates to 0 is intentional). Ribbon colors are
  theme-flipping tokens (sad: neutral-800 bg + neutral-100 text) so contrast
  holds in both modes. GSAP moves the `.fx-cloud-wrap` transforms while the
  ambient CSS drift lives on the inner `.fx-cloud`; never put both on one
  element or the CSS animation wins.
  The whole system is REMOVABLE AS A UNIT: the `.fx-*` markup block in
  index.html, the fx CSS section in presentation.css, the `--sous-fx-*`
  tokens, and the "Sad/happy effects" section of presentation.js.

Each scene also gets a second label, `<name>-shown`, placed right after its
entrance animation. **Chapter-bar clicks and ArrowLeft/Right jump to the
`-shown` labels** — jumping to the bare scene-start label would land on a blank
frame (entrance not yet run). The bare labels remain the segment boundaries for
the chapter bar.

### Implementation decisions (docs/js/presentation.js)

- **Pacing is computed, not managed.** `computeStepDelay(element)` in
  presentation.js derives each scene's 1x hold from its text via a
  reading-speed model: a token is a word weighted by length
  (`ceil(letters / 5)`, so "variables" ~2, "and" 1). ALL pacing scales from
  ONE knob, `baseDelay` (currently 200): prose tokens cost `perTokenDelay`
  (baseDelay), diagram-label tokens (text inside `svg`) cost
  `perDiagramTokenDelay` (baseDelay × 1.75; labels are a proxy for structural
  density), `minStepDelay` (baseDelay × 25) floors everything, and callout
  dwells are `calloutBaseDelay` (baseDelay × 15.625) + tip tokens at the prose
  rate; tooltip text is excluded from base holds. Tune overall pacing via
  `baseDelay`; tune the RATIOS only if a category (diagrams, callouts) feels
  off relative to prose. A `SCENES` entry may still carry an explicit `hold` (seconds) as a
  rarely-used trump card; currently only intro (play skips it), templates
  (callouts supply the dwell), and outro (end card) do.
- Roughly 13 minutes total at 1x across 37 scenes (measured 16:30 before the P1-P3 merge; target is 8:00, trimming continues) (holds and dwells were
  doubled at Luke's direction on 2026-08-13; the problems then went from
  two slides each to five, tripling the problem-scene count; transition/fade
  durations were deliberately NOT doubled). Scene
  text lives in `index.html`; elements to animate are marked
  `class="anim"`. `sceneIn`/`sceneOut` helpers build each scene's child
  timeline (autoAlpha + y, staggered); the `SCENES` array is the single scene
  manifest (ids, bar titles, optional explicit hold overrides).
- `gsap.killTweensOf(tl)` also kills the tween backing the `quickTo` smoother,
  so the quickTo is **recreated** after every kill (`killScrubTweens()`).
- Wheel deltas clamped to ±60px/tick; scrub speed 0.02 s of timeline per pixel;
  touch/pointer drag direction inverted so dragging up moves forward.
- The Observer targets the stage only (`preventDefault` therefore only applies
  over the player, and only while enabled = paused); `touch-action: none` on
  the stage; `user-select: none` while scrubbable.
- Ended state re-enables scrub; pressing play at progress 1 restarts from 0.
- Every non-final scene also has a `<name>-exit` label (hold over, exit
  animation begins). `play()` seeks to `intro-exit` whenever the playhead is
  inside the intro (including replays) — the title scene is static, so there
  is nothing to watch before its exit.
- Keyboard: Space toggles play/pause (ignored when focus is on a control);
  ArrowLeft/Right jump scenes (Left returns to the current scene's `-shown`
  point first when >0.5s past it).
- There is no autoplay at all; playback only ever starts from a user
  gesture. (Reduced-motion gating was REMOVED at Luke's direction,
  2026-08-14; see the style principles note.)
- **Callout system** (`SCENE_EXTRAS` map + `calloutsTimeline`): a scene can
  register an extra child timeline inserted after its `-shown` label. The
  templates scene uses it to fade `.hl` highlight/tooltip pairs in and out in
  document order (0.35s fade, 6s dwell). Template-pane callouts: the
  `{{ projectRoot }}/src/models` path ("Embedding absolute paths reduces CWD
  mistakes that tools often make"), the whole `{% if tool %}` block
  ("Providing tool-specific instructions increases consistency by reducing
  ambiguity."), and the `globDirectory` line ("Using helpers to generate
  content keeps your project code as the source of truth"). Tooltips wrap
  at 26rem, centered, balanced. Markup:
  `<span class="hl"><span class="hl-bg"></span>…code…<span class="hl-tip">tip</span></span>`;
  MULTI-LINE highlights need `hl hl-block` (inline-block): a fragmented
  inline's abspos reference box ends at the last fragment's right edge, which
  truncates the background at e.g. a short `{% endif %}`. Code windows keep
  `overflow` VISIBLE (titlebar rounds its own top corners) so tooltips can
  extend past the window edges; consequence: long code lines must fit the
  window, there is no horizontal scroll;
  colors/positioning live in CSS, JS only animates autoAlpha, so it scrubs
  correctly. Tooltips are brand green with black text matching the `.lead`
  type (size-l, weight 400), plus a subtle metal-plate sheen
  (`--sous-metal-sheen` gradient layered over `--sous-primary`, with inset
  top-highlight/bottom-shade shadows) and a bordered arrow pointing down at
  the highlight; highlights carry a subtle yellow ring + glow
  (`--sous-hl-outline` / `--sous-hl-glow` tokens) to pull focus.
- **No load flicker:** every element that should start hidden (player
  controls, speed control, orb, cloud wraps, tint, gloom, rain, banners) is
  hidden in CSS (`opacity: 0`), and GSAP owns the reveal; JS-only initial
  hiding flashes for a frame before scripts run. The orb's working opacity is
  0.55, faded up by `skyIn`.
- **Corner links:** fixed top-RIGHT icon buttons (`.repo-link` chrome, shared
  via css/chrome.css), ordered left-to-right: [speed control] [theme toggle]
  [GitHub mark] [npm text mark]; GitHub links to the repo, npm to
  npmjs.com/package/@sous-io/sous, both new-tab and always visible.
  Positions are right-anchored calc() offsets in 2.5rem + gap steps.
  Fixed top-LEFT sits a plain "Documentation" TEXT link (`.docs-link` in
  chrome.css; NO button chrome, Luke's direction 2026-08-27): body-text
  colored (so white in dark mode), semibold, green on hover, linking to
  `docs/#/`.
- **Intro hides the chrome:** the bottom control bar and the speed control
  are hidden on the title scene; two `fromTo` tweens inserted into the master
  timeline at `intro-exit` slide the bar up from below (`yPercent`) and fade
  the speed control in, so scrubbing back into the intro re-hides them.
- **Reload persistence:** the playhead progress is saved to sessionStorage
  (`sous-presentation-progress`) on `beforeunload` and restored (paused) on
  load; per-tab only, so fresh visitors start at 0. Added for hot-reload
  preview workflows (PhpStorm preview).
- **Presentation speed:** a fixed `.speed-control` segmented toggle next to
  the theme toggle (Speed: 0.5x / 0.75x / 1x / 1.25x / 1.5x / 2x, default 1x;
  the sub-1x options exist for slow readers) drives GSAP's
  native `tl.timeScale(v)`; applies immediately, even mid-play, and scales
  everything (holds AND transitions, video-player semantics). Scrubbing is
  progress-based and unaffected. Choice persists per tab in sessionStorage
  (`sous-presentation-speed`). Hidden under `html.no-gsap`.
- If the GSAP CDN fails, `html.no-gsap` is set: the title scene remains as a
  static splash and the player chrome is hidden (same for `<noscript>`).
- The favicon 404 in devtools is pre-existing; the site has no favicon yet.

### Chosen stack (researched 2026-08; frameworks like Reveal.js were ruled out —
discrete-step architectures cannot pause mid-animation or scrub continuously)

- **GSAP 3 core + Observer plugin** from jsdelivr (~27 KB gz total):
  - `https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js`
  - `https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/Observer.min.js`
- GSAP is 100% free including all plugins (post-Webflow "GSAP Standard
  License": free for commercial use, proprietary/not OSI; only restriction is
  building a competing no-code animation tool). MIT fallback if ever needed:
  anime.js v4.
- **Icons: Lucide** (MIT, stroke-based; matches the theme's flat/outline look
  and the hand-inlined feather-style icons already in the page):
  `https://cdn.jsdelivr.net/npm/lucide@1.31.0/dist/umd/lucide.min.js`.
  Usage: `<i data-lucide="<name>" class="card-icon" aria-hidden="true"></i>`
  placeholders, swapped to inline SVGs by `lucide.createIcons()` (called in a
  small inline script before `presentation.js`). Stroke follows
  `currentColor`. Browse names at https://lucide.dev/icons/.

### Architecture (the proven pattern)

- **One master `gsap.timeline({ paused: true })` is the single source of
  truth.** One child timeline per scene; `tl.addLabel("<scene-name>")` at each
  scene start. `tl.labels` (`{name: seconds}`) is the data model for the
  chapter bar; `tl.currentLabel()` drives the active-scene highlight.
- Two playhead drivers, never simultaneously active:
  - **Playing:** GSAP's ticker. All UI renders from the timeline's `onUpdate`
    (read `tl.progress()` + `tl.currentLabel()`).
  - **Paused:** an `Observer` (type `"wheel,touch,pointer"`) maps deltas to a
    smoothed progress tween — create once with
    `gsap.quickTo(tl, "progress", {duration: 0.6, ease: "power3"})`; the ease
    provides inertia. Enable the observer on pause, disable on play.
- **Chapter jumps:** `tl.tweenTo(label)` (animated). Gotchas: it pauses the
  timeline and does NOT auto-resume — restore play state in `onComplete`.
- **Chapter bar:** custom-built (~100 lines; no off-the-shelf option fits — the
  video-player chapter bars all require a media element). Accessible core: a
  styled `<input type="range" min="0" max="1" step="0.001">` with scene
  `<button>`s overlaid (`aria-current` on the active one).

### Known pitfalls (design these in from the start)

- Clamp per-tick wheel deltas (one fast notch must not teleport the playhead);
  the smoothing tween is the ONLY inertia source (trackpads emit momentum
  events >1s after release).
- `preventDefault` wheel events only while scrub mode is active and over the
  player; `touch-action: none` on the player element for touch. Decide edge
  behavior at progress 0/1 (release to page scroll vs stay captured).
- Kill any in-flight scrub tween (`gsap.killTweensOf(tl)`) before `tl.play()`.
- Accessibility: Space = play/pause; ArrowLeft/Right =
  `tl.tweenTo(tl.previousLabel()/nextLabel())`. (Reduced-motion gating
  removed at Luke's direction, 2026-08-14.)

### Reference material

- GSAP forum topic 41263 — "Use any timeline as a step-through on scroll using
  the Observer plugin" (closest published match; three CodePens by mvaneijgen).
- Official Observer demo: https://codepen.io/GreenSock/pen/XWzRraJ
- Timeline-scrubbing/smoothing thread: GSAP forum topic 28570.
- Apple-style scrollytelling architecture: CSS-Tricks "fancy scrolling
  animations used on Apple product pages" (same 0–1 progress model).

## Working on the site

- **Local preview:** `python3 -m http.server` from `docs/` (localStorage and
  some APIs are flaky on `file://` URLs).
- The site's HTML/CSS/JS sources under `docs/` are hand-written and tracked in
  git normally. The ONLY sous-generated file in `docs/` is this CLAUDE.md.
- The repo-root `CLAUDE.md` covers the Sous CLI itself; this file covers only
  the website. BOTH are sous-generated from tracked sources under
  `.sous/prompts/` (`root/CLAUDE.md` and `docs-site/CLAUDE.md` respectively).
