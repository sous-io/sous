# sous serve: web editor (proof of concept)

`sous serve` starts a local web server for the current project and opens a browser-based
editor for every source file sous reads. This folder is the editor's frontend (React, Vite,
Tailwind and shadcn/ui); the server side is in `src/commands/serve.ts` and `src/lib/serve/`.

This is a proof of concept: nothing is saved, and only the editor works.

## Running It

```bash
npm --prefix web install
npm --prefix web run build
./bin/sous serve              # opens the browser when the server is ready
./bin/sous serve --no-launch  # prints the URL only
```

`--port <n>` picks the port (default 4777; the next free port is used if it is taken). The
server listens on 127.0.0.1 only, and every API call needs the random token in the printed
URL, because the API returns variable values.

## What Works

- Every source file sous reads (compile targets and the partials they include), from this
  project and from its recipes, in three trees: by recipe (repo › namespace › recipe › file),
  by file on disk, and by output file.
- `.tpl.md` files open with each top-level Liquid section shown as its rendered output, using
  this project's real variables. Put the cursor in a section to see and edit its Liquid; it
  re-renders about 250 ms after typing stops, and immediately when the cursor leaves it or the
  editor loses focus. **Source** mode shows the plain file.
- The output pane shows the whole rendered file. Click a highlighted piece to jump to the
  Liquid that wrote it.
- A Liquid error keeps the last good render on screen and shows the error in the status bar.
- Edits stay in the browser tab. The diffs in the contribute dialog are computed from them.

The sample file `poc-samples/liquid-showcase.tpl.md` exists only in the server's memory. It
shows blocks, loops, `capture` and sous's `listFiles` tag, which real recipe templates rarely use.

## What Is Mocked

- **Sending changes** (the "Send N changes" button): one proposal per place the edits came
  from. A recipe repository gets a pull request with a version raise, a title and
  description (with a mocked "Write it with Claude"), and the `sous repo contribute` commands
  it stands for. Project files get a commit and a pull request. The progress steps and the
  pull request are simulated.
- **Proposals**: tracks each proposal from opened to released, then offers the update.
- **Variables**: the values are real; the "Set in" column is invented.
- **Recipes**: the list is real; the "update available" badges are invented.
- **Build**: the output list is real; its status and the Rebuild button are simulated.
- **History** tab in the editor.

## How Rendering Works

The editor's document is always the template source. For each render, the server:

1. Splits the template into top-level Liquid sections with the LiquidJS tokenizer: an
   `{{ output }}`, an inline tag, or a whole block from its opening tag to its matching end tag.
2. Wraps each section in invisible markers, renders the whole file once with sous's own Liquid
   engine (aliases, `{% render %}` paths, custom tags), and cuts the output at the markers.
3. Returns each section's position and rendered text. The editor draws the rendered text over
   every section except the one the cursor is in.

Rendering the whole file at once keeps `{% assign %}` and `{% capture %}` working across
sections. The markers can change whitespace inside a section that uses `{%-`/`-%}` trimming.
