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

## Where to look

- Watch the [animated introduction](../) for the full pitch
- Learn [how sous is configured](configuration.md)
- Read the [source on GitHub](https://github.com/sous-io/sous)
