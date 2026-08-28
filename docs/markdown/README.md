# Sous Documentation

Sous is an agent configuration manager for LLM coding tools: it compiles markdown templates,
aggregates configuration from many sources, and keeps the files your coding agents rely on
current. The CLI is called `xcv` and ships on npm as
[`@sous-io/sous`](https://www.npmjs.com/package/@sous-io/sous).

```term
$ npm install -g @sous-io/sous
>> 100%
$ xcv build
building "My Project"...
compiled 4 targets, pruned 1 stale file
```

?> These docs are young. The **Configuration** section is the first reference material; more
will follow.

## How this site works

The whole docs section is a thin static shell: every page is a plain markdown file in the
[repository](https://github.com/sous-io/sous/tree/main/docs/markdown), fetched and rendered live in
your browser. Publishing a new page is a two-line change:

1. Commit a markdown file to `docs/markdown/`
2. Add one line to `_sidebar.md`

There is no build step and no generated HTML.

## Where to look

- Watch the [animated introduction](../) for the full pitch
- Learn [how sous is configured](configuration.md)
- Read the [source on GitHub](https://github.com/sous-io/sous)
