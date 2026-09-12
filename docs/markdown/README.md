# Sous Documentation

Sous is an agent configuration manager for LLM coding tools: it compiles markdown templates,
aggregates configuration from many sources, and keeps the files your coding agents rely on
current. The CLI is called `sous` and ships on npm as
[`@sous-io/sous`](https://www.npmjs.com/package/@sous-io/sous). Earlier releases installed the
same CLI under the name `xcv`; every command below is unchanged apart from that name.

```term
$ npm install -g @sous-io/sous
>> 100%
$ sous build
building "My Project"...
compiled 4 targets, pruned 1 stale file
```

?> These docs are young. **Configuration** and **Repositories** are the reference material so
far; more will follow.

## Where to look

- Watch the [animated introduction](../) for the full pitch
- Learn [how sous is configured](configuration.md)
- Share configuration between projects with [repositories](repositories.md)
- Look up a command in the [command reference](commands.md)
- Read the [design principles](design-principles.md) that constrain every feature
- Read the [source on GitHub](https://github.com/sous-io/sous)
