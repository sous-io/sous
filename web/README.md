# sous serve: web editor (proof of concept)

`sous serve` starts a local web server for the current project and opens a browser-based
GUI for it. The centrepiece is an editor that shows every `.tpl.md` file rendered with the
project's real variables, with each Liquid section editable in place. Around it are pages
for the agent's context, variables, config, recipes, the build, and sending edits upstream.

This folder is the frontend (React, Vite, Tailwind and shadcn/ui). The server side is in
`src/commands/serve.ts` and `src/lib/serve/`.

This is a proof of concept. Nothing is saved to disk, and nothing is sent anywhere.

## Running It

```bash
npm --prefix web install
npm --prefix web run build
./bin/sous serve              # opens the browser when the server is ready
./bin/sous serve --no-launch  # prints the URL only
```

- `--port <n>` picks the port. The default is 4777, and the next free port is used if it's
  taken.
- The server listens on 127.0.0.1 only.
- Every API call needs the random token in the printed URL, because the API returns
  variable values. `SOUS_SERVE_TOKEN` sets the token yourself.

## What Is Real

Everything below reads the real project, the real recipe store (`~/.sous/cache`), and sous's
own code.

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

- **Live.** `sous serve` watches every source and output on disk. A file you haven't edited
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
- **Build:** what `sous build` would write right now, compared with what is on disk. It is
  built into a temporary folder in about 0.6 seconds.
- **Send changes,** up to the Propose button:
  - grouping by destination;
  - `gh` sign-in and push access;
  - the commit at the head of upstream's main branch;
  - the 3-way merge onto upstream;
  - the version raise, counted from upstream;
  - core recipes routed to sous-io/sous;
  - the "make it generic" scan for your own values and secrets;
  - the three diffs.

The `Ctrl`+`K` palette opens any file and runs any command.

## What Is Simulated

- **Sending:** link, commit, push, fork, and opening the pull request. The PR number is
  invented.
- **The proposals' later states,** "Update this project", and subscribing to a recipe.
- **The editor's History tab.**

The sample file `poc-samples/liquid-showcase.tpl.md` exists only in the server's memory. It
shows blocks, loops, `capture` and `listFiles`, which real recipe templates rarely use.

## How Rendering Works

The editor's document is always the template source. For each render, the server:

1. Splits the template into top-level Liquid sections with the LiquidJS tokenizer: an
   `{{ output }}`, an inline tag, or a whole block from its opening tag to its matching end
   tag.
2. Wraps each section in invisible markers. It also adds a marker at the start of each branch
   of an `if`, `case` or `for`.
3. Renders the whole file once, then cuts the output at the markers. Each section's output and
   position come back, along with which branches ran and how many times.

Rendering the whole file at once keeps `{% assign %}` and `{% capture %}` working across
sections. Markers sit after any whitespace a `-%}` trims, so the output matches a real build.

## Server Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/workspace` | Project, branch, files |
| `GET /api/file?id=` | A file's text, its variables, and a first render |
| `POST /api/render` | A render of edited text, optionally with tried-out variable values |
| `GET`/`POST /api/build` | The preview build (`POST` runs it again) |
| `GET /api/output?path=` | One output's built text |
| `GET /api/variables` | The variables report |
| `GET /api/config` | The config layers |
| `GET /api/recipes` | The recipe store catalog |
| `GET /api/drift?id=` | Hand edits to a file's output |
| `GET /api/builtins` | Variable names sous sets itself |
| `GET /api/contribute-info?ids=` | Everything the send dialog checks |
| `GET /api/my-prs` | Your pull requests on these repositories (read-only `gh`) |
| `POST /api/includes` | Where each `@include` line of a text points |
| `GET /api/recipe-diff?key=&from=&to=` | Two versions of a recipe, rendered and compared |
| `GET /api/events?token=` | Server-sent events when files change on disk |
