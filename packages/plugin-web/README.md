# @sous-io/plugin-web

`sous serve`: a local web editor for a sous project (proof of concept). The centrepiece is an
editor that shows every `.tpl.md` file rendered with the project's real variables, with each
Liquid section editable in place. Around it are pages for what the agent reads, variables,
config, recipes, the build, every command, and sending edits upstream.

It is a separate plugin, not one of sous's built-ins: a project turns it on.

## Turning It On

Build it once:

```bash
pnpm --filter @sous-io/plugin-web build    # the server (dist/) and the frontend (web/dist/)
```

Then either list it in the project's config:

```yaml
plugins:
  load: ["@sous-io/plugin-web"]
```

or turn it on for one run:

```bash
SOUS_PLUGINS=$PWD/packages/plugin-web/dist/index.js ./bin/sous serve
```

- `sous serve` opens the browser when the server is ready; `--no-launch` only prints the URL.
- `--port <n>` picks the port. The default is 4777; the next free port is used if it's taken.

## How the Browser Talks to Sous

The page is plain HTTP. Everything else goes over one WebSocket (`/ws`), where the browser
runs intents, the same ones the CLI and the MCP server run. The messages are defined once, in
`src/protocol.ts`, which the frontend imports too:

```jsonc
// browser → sous
{ "type": "run", "id": 7, "intent": "clear", "input": {} }
// sous → browser
{ "type": "ask", "id": 7, "ask": 1, "question": { "kind": "confirm", "message": "Delete 67 file(s)…?", "default": false } }
// browser → sous
{ "type": "answer", "id": 7, "ask": 1, "value": false }
// sous → browser
{ "type": "result", "id": 7, "ok": true, "data": { "confirmed": false, "removed": [] }, "ms": 3 }
```

- Each run is one chain, submitted with the browser's own reporter (`report` messages), prompter
  (`ask` / `answer`) and cancel signal (`cancel` aborts `ctx.signal`).
- A run may carry `preview` settings: it then runs against a "what if" config with those
  values set. Only intents declared `readOnly` run there; any other is refused before it starts.
- `event` messages tell every tab when files change on disk or the config is rebuilt.
- The browser reconnects by itself when sous restarts.

**Security.** The socket can run any intent, so only the page sous opened may use it:
- the server listens on 127.0.0.1 only;
- a socket's first message must carry the random token, which reaches the page in the URL's
  fragment (`#token=…`), so it is never sent in a request or written to a log, and the page
  removes it from the address bar at once (`SOUS_SERVE_TOKEN` sets it yourself);
- a socket whose `Origin` is not this server is refused, because browsers apply no cross-site
  rules to WebSockets (`SOUS_SERVE_ORIGINS` adds origins, for `vite dev`).

## The `web.*` Intents

The editor's data comes from these intents. Each builds its answer from the plugins that own
the facts; none reimplements one. They are `internal` (the CLI and agents have the owners' own
commands), read-only and parallel.

| Intent | What it returns | Built from |
|---|---|---|
| `web.workspace` | every source file, its origin and outputs | `compiler.targets`, a dry-run `compiler.compile`, `recipes.active`, `git.runner` |
| `web.file` | a file's text, variables and first render | `variables.resolver`, `variables.secrets`, `web.render` |
| `web.render` | a render of edited text, with values being tried | `liquid.regions` (sections), `compiler.render` (the render, the token count) |
| `web.includes` | where each `@include` line points | `compiler.includes` |
| `web.build` | a dry run of every target, with tokens and status | `compiler.compile` (`dryRun`, `includeContent`, `countTokens`) |
| `web.output` | one output's built text | the last `web.build` |
| `web.drift` | hand edits to a file's output | `web.build` and the file on disk |
| `web.variables` | every variable, its value, who answered it, where it is used | `vars.list`, `variables.resolver`, `liquid.regions` |
| `web.builtins` | the variables sous sets itself | `variables.resolver` |
| `web.config` | the config layers and the final settings | `config.show --layers` |
| `web.recipes` | every recipe in the store, with the version in use | `recipes.store`, `recipes.active`, `formats.manifests` |
| `web.recipe-diff` | two versions of a recipe, rendered and compared | `recipes.store`, `web.render` |
| `web.contribute-info` | what the send dialog checks | the `repository-host` entities, `recipes.*`, `git.runner` |
| `web.scan-secrets` | secret values in lines about to be sent | `variables.secrets` |
| `web.my-prs` | your pull requests on these repositories | `gh`, read-only |

## What Is Real

**Editor**
- **Three trees** over every source file sous reads (compile targets and the partials they
  include):
  - by source: repository › namespace › recipe › file;
  - by file on disk;
  - by output file, with token counts and status.
- **Rendered Liquid.** Each top-level Liquid section shows its output, rendered by sous's own
  Liquid engine with this project's variables.
  - Inline values take the heading, bold or code styling around them.
  - Blocks are drawn as cards that say which branch ran (`showing else · 1 hidden`) or how
    many times a loop ran (`×5`).
- **Editing a section.** Click a section to edit its Liquid. The cursor lands inside the
  expression.
  - While you edit, a bar shows what the section renders to, live.
  - `Esc`, or clicking outside, renders it again.
- **Errors.** A Liquid error marks the broken section. The last good output stays on screen,
  marked out of date.
- **Autocomplete.** After `{{ ` it offers the variables, with their values. After `{% ` it
  offers tags, including sous's `listFiles` and `getFiles`. After `|` it offers filters. An
  `@` at the start of a line offers include paths. `{{` and `{%` close themselves.
- **Variable hover.** Hover a variable inside Liquid to see its value, which recipe asks for
  it, and which file and environment variable set it.
- **Plain errors.** LiquidJS's common errors are reworded, for example "This {% if %} has no
  matching {% endif %}".
- **Keys.** `Alt`+`↑`/`↓` jumps between sections. `Ctrl`+`S` says what saving means here.
- **Gutter and file furniture.**
  - Change bars mark the lines you edited.
  - Cards show the range of lines they replace.
  - YAML frontmatter is drawn as a muted block.
  - Each `@include` line shows the file it points to, resolved by sous's own include
    resolver. Click the chip to open it. A broken include is marked red and says why the
    build fails.
- **Source mode** shows the plain file.
- **The inspector panel:**
  - **Output:** the whole rendered file, as Text (click a piece to jump to the Liquid that
    wrote it), Preview (rendered markdown), or What changed (a diff of the output against the
    file on disk).
  - **Variables:** every variable, with the ones this file uses listed first. Click a value to
    try another one; only the preview changes.
  - **Used by:** every output that includes this file, with token counts.
- **Hand-edit rescue.** A banner appears when a built output was edited by hand, and moves
  each edit into the template. For the sample file the on-disk copy is simulated; for real
  outputs it compares a fresh build with the file on disk.
- **Undeclared variables.** A banner warns when a recipe file reads a variable that its
  recipe (and the recipes it depends on) doesn't declare. This uses LiquidJS static analysis
  against `sous.recipe.yaml`.

- **Live.** `sous serve` watches every source, partial, recipe file, config file and output
  on disk, through plugin-build's `build.watcher`. A file you haven't edited
  reloads when it changes; one you have edited shows a "changed on disk" banner. The build data
  refreshes either way.
- **Share as a recipe** (project files): proposes the file as a new recipe. It generates
  `sous.recipe.yaml`, replaces this project's own values with variables, and shows how the
  project would use the recipe. Sending is simulated.
- **URLs.** Every page and open file has its own URL, so back, forward and reload work. A
  first visit lands on Home, which offers a one-minute guided tour.

**Pages**
- **Home:** the project at a glance, and what needs attention: failing outputs, unanswered
  variables, recipe updates, unsent edits, and outputs not built yet.
- **Agent view:** what Claude reads at the start of a session (instructions plus the skill
  menu) and what it reads only when needed, in tokens, from a fresh build.
- **Variables:** what `sous vars list` reports, for each variable:
  - who asks for it;
  - its value;
  - which environment variable and file answered it;
  - the files that use it.
- **Config:** the config layers in merge order, what each one sets, and which file set each
  final value.
- **Recipes:** the recipes this project uses and the others already downloaded, with
  descriptions, contents, variables, dependencies, and updates. "See what X changes" renders
  both versions of a recipe with your variables and diffs what your agent would read.
- **Agent view** also has "Which skill would load?". It ranks skills by the words their
  descriptions share with a request. It's a rough guess, and it is labelled as one.
- **Proposals:** your real pull requests on these repositories, read live and read-only from
  `gh`, plus the ones sent from this session.
- **Build:** what `sous build` would write right now, compared with what is on disk: a dry run
  of every output, in under a second.
- **Send changes,** up to the Propose button:
  - grouping by destination;
  - `gh` sign-in and push access;
  - the commit at the head of upstream's main branch;
  - the 3-way merge onto upstream;
  - the version raise, counted from upstream;
  - core recipes routed to sous-io/sous;
  - the "make it generic" scan for your own values and secrets;
  - the three diffs.

- **Commands:** every command sous has, from every plugin, with a form built from the
  command's own input schema. What it reports streams in; questions it asks open as dialogs
  (Enter takes the safe answer). A command a plugin adds later shows up with no web code.

The `Ctrl`+`K` palette opens any file and runs any command. `Ctrl`+`` ` `` opens a log of every
socket message.

## What Is Simulated

- **Sending:** link, commit, push, fork, and opening the pull request. The PR number is
  invented.
- **The proposals' later states,** "Update this project", and subscribing to a recipe.
- **The editor's History tab.**

The sample file `poc-samples/liquid-showcase.tpl.md` exists only in the server's memory. It
shows blocks, loops, `capture` and `listFiles`, which real recipe templates rarely use.


## Developing the Frontend

```bash
SOUS_SERVE_TOKEN=dev SOUS_SERVE_ORIGINS=http://localhost:5173 \
  SOUS_PLUGINS=$PWD/packages/plugin-web/dist/index.js ./bin/sous serve --no-launch
npm --prefix packages/plugin-web/web run dev     # then open http://localhost:5173/#token=dev
```

## Where Things Are

- `src/index.ts`: the plugin, and the `web.serve` intent (`sous serve`).
- `src/server.ts`: the HTTP server, the socket, its sessions, the file watching.
- `src/protocol.ts`: the socket's messages, shared with the frontend.
- `src/socket-io.ts`: the browser's reporter and prompter.
- `src/intents/`: the `web.*` intents.
- `src/types.ts`: the intents' input and result types.
- `web/`: the frontend (React 19, Vite, Tailwind v4, shadcn/ui on Base UI, CodeMirror 6,
  zustand). `web/src/lib/socket.ts` is the connection; `web/src/lib/api.ts` the editor's data.
