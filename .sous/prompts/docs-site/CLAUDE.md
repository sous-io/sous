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
  Sous, with movie-player controls (see "The presentation" below).
- **Someday:** full documentation for Sous.

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
| `docs/css/main.css` | The design-system stylesheet: all tokens, base element styles, minimal foundational classes. |
| `docs/css/presentation.css` | Page + player styles for `index.html` (stage, scenes, control bar, chapter segments, theme toggle). Everything references `--sous-*` tokens. |
| `docs/js/presentation.js` | The presentation logic (vanilla JS IIFE): master timeline, scene builds, Observer scrubbing, chapter bar, keyboard controls. |
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
4. Subtle motion only, always guarded by `prefers-reduced-motion`.

### Theming mechanics

- Auto light/dark via `prefers-color-scheme`; forced via
  `data-sous-theme="light|dark"` on `<html>`.
- The toggle in `index.html` persists to localStorage key **`sous-theme`**; an
  inline `<head>` script re-applies it before first paint (no flash). Keep this
  mechanism on every future page.

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

### Scenes (in order; label name = `data-scene` attr in `index.html`)

| Label | Bar title | Content |
|-------|-----------|---------|
| `intro` | Intro | Title scene: logo, "Your coding agent's assistant", tagline, `$ npm install -g @sous-io/sous` prompt motif, big play button. Visible statically before play (and if JS/GSAP fails). Pressing play skips the rest of the intro hold and transitions away immediately (the user has already consumed the static scene). |
| `features` | Core Systems | The two core systems as tiles with Lucide icons: Config Aggregation (`combine`) + Liquid Templates (`braces`); tagline "It's a bit like [Helm](https://helm.sh), but for AI coding tools." |
| `aggregator` | Aggregator | Core system #1 explained: inline-SVG orbit diagram; six same-size circles (Project/Department/Company/Personal/2× Public Repo, two-line labels, r=48) orbit a central "Project" circle, green dashed flow lines (CSS `orbit-flow` marching-dash animation, disabled under reduced motion) with arrowheads pointing inward. All colors from tokens. |
| `templates` | Templates | Core system #2 explained as SUB-SCENES in one `.code-stack` (two VS Code-style windows overlapping in one grid cell; `--sous-editor-*` tokens): first the `SKILL.tpl.md` template (YAML frontmatter, `{{ projectRoot }}` injection, `{% if tool %}` claude-code/codex branch about HOW TO APPLY EDITS deliberately unrelated to the glob, fictitious `{% globDirectory dir="{{ projectRoot }}/src/models" pattern="**/*Model.ts" %}`) with its callout walkthrough, then a crossfade to the rendered `SKILL.md` window (full skill output, fictitious absolute `/projects/backend/src/models/...` paths, one nested under `billing/` proving the `**`) with its own callout. Sequenced by `templatesTimeline` in presentation.js. Hand-highlighted with `tok-*` spans; code font is `--sous-font-size-base`. |
| `what` | What is Sous | What Sous is: CLI (`xcv`) compiling markdown templates into prompts/skills/context per tool. |
| `problems` | The Problems | 2×2 tile grid: sharing forks, projects start over, tool switches hurt, context rots. |
| `how` | How It Works | 2×2 tile grid: variables live outside, one skill many projects, fresh dynamic context, one build for any tool. |
| `non-goals` | Non-Goals | "A tool, not a framework": prefers native features, no opinions, only the unfilled gap. |
| `outro` | Get Started | `$ xcv launch claude` motif + GitHub link (github.com/sous-io/sous). Stays on screen at the end. |

### Working rules for scene work (Luke's direction, 2026-08)

- **NEVER use em-dashes in copy.** Use semicolons to join clauses, commas or
  parentheses for appositives. This applies to ALL text on the site.
- **Never remove a scene unless explicitly told to** — superseded scenes stay
  for reference and ideas. When Luke describes a slide unlike any existing
  one, INJECT a new scene at the position being described.
- **Lean into animated charts and diagrams** (and eventually code snippets) —
  the presentation should be visual, not text tiles forever.
- **Scene holds will likely grow much longer**, and the chapter bar is running
  out of horizontal space — some notion of *scene categories/grouping* in the
  bottom bar is an open design problem to solve soon.

Each scene also gets a second label, `<name>-shown`, placed right after its
entrance animation. **Chapter-bar clicks and ArrowLeft/Right jump to the
`-shown` labels** — jumping to the bare scene-start label would land on a blank
frame (entrance not yet run). The bare labels remain the segment boundaries for
the chapter bar.

### Implementation decisions (docs/js/presentation.js)

- ~30s total. Scene text lives in `index.html`; elements to animate are marked
  `class="anim"`. `sceneIn`/`sceneOut` helpers build each scene's child
  timeline (autoAlpha + y, staggered); holds are per-scene in the `SCENES`
  array, which is the single scene manifest (ids, bar titles, holds).
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
- `prefers-reduced-motion` (via `gsap.matchMedia`): jumps use instant
  `tl.seek()`, wheel scrub sets progress directly (no smoothing tween). There
  is no autoplay at all; playback only ever starts from a user gesture.
- **Callout system** (`SCENE_EXTRAS` map + `calloutsTimeline`): a scene can
  register an extra child timeline inserted after its `-shown` label. The
  templates scene uses it to fade `.hl` highlight/tooltip pairs in and out in
  document order (0.35s fade, 1.8s dwell). Markup:
  `<span class="hl"><span class="hl-bg"></span>…code…<span class="hl-tip">tip</span></span>`;
  colors/positioning live in CSS, JS only animates autoAlpha, so it scrubs
  correctly. Tooltips sit 16px above the highlight with a bordered arrow
  pointing down at it; highlights carry a subtle yellow ring + glow
  (`--sous-hl-outline` / `--sous-hl-glow` tokens) to pull focus.
- **Reload persistence:** the playhead progress is saved to sessionStorage
  (`sous-presentation-progress`) on `beforeunload` and restored (paused) on
  load; per-tab only, so fresh visitors start at 0. Added for hot-reload
  preview workflows (PhpStorm preview).
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
  timeline and does NOT auto-resume — restore play state in `onComplete`; under
  reduced motion use instant `tl.seek(label)` instead.
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
- Accessibility: no autoplay under `prefers-reduced-motion`
  (`gsap.matchMedia`); Space = play/pause; ArrowLeft/Right =
  `tl.tweenTo(tl.previousLabel()/nextLabel())`.

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
