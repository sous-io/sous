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

## Installing

Sous installs three ways, and they work together:

- **Globally** (`npm install -g @sous-io/sous`): one `sous` on the path for every project on the
  machine, and the one to reach for first.
- **In a project** (`npm install -D @sous-io/sous`): the project pins the version its templates
  and its lockfile were written against, and `npx sous` or a package script runs it. This is the
  right choice for a team, because the implicit `core` subscription asks for exactly the running
  version and a project built by two versions in turn rewrites its committed lockfile back and
  forth.
- **Both**: a global `sous` run anywhere inside a project that holds `node_modules/@sous-io/sous`
  hands the whole command to that copy before loading any of its own code, so the project's
  version always does the building however it was invoked. The lookup walks up from the working
  directory the way Node resolves a package, so a copy hoisted to a monorepo root is found from
  any package inside it.

When the two versions differ, one sentence on standard error names the copy that ran and the
one you invoked; standard output is untouched, so a piped command prints exactly what it always
did. Set `SOUS_DEBUG` and the sentence prints on every hand-off. Set `SOUS_NO_DELEGATE` to
anything but `0`, `false`, `no` or `off` to run the copy you invoked instead, for debugging a
broken project install or for deliberately using the global one:

```term
$ sous --version
Running the project's own sous 0.2.4 from /work/app/node_modules/@sous-io/sous instead of the sous 0.3.0 you invoked; set SOUS_NO_DELEGATE=1 to run the one you invoked.
@sous-io/sous/0.2.4 linux-x64 node-v22.21.0
$ SOUS_NO_DELEGATE=1 sous --version
@sous-io/sous/0.3.0 linux-x64 node-v22.21.0
```

## Where to look

- Watch the [animated introduction](../) for the full pitch
- Learn [how sous is configured](configuration.md)
- Get a project subscribed to shared recipes in ten minutes with the
  [repositories quickstart](repositories-quickstart.md)
- Share configuration between projects with [repositories](repositories.md)
- See how each hosting provider behaves in the [provider reference](repositories-providers.md)
- Look up a command in the [command reference](commands.md)
- Work out what an error is telling you in [repositories troubleshooting](repositories-troubleshooting.md)
- Read the [design principles](design-principles.md) that constrain every feature
- Read the [source on GitHub](https://github.com/sous-io/sous)
