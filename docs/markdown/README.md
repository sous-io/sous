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

When the two versions differ, one line on standard error names the version handed off to;
standard output is untouched, so a piped command prints exactly what it always did. Add
`--verbose` to any command, or set `SOUS_DEBUG`, and every hand-off is announced, with where
both installs are and how to keep the invoked one running. Set
`SOUS_NO_DELEGATE` to anything but `0`, `false`, `no` or `off` to run the copy you invoked
instead, for debugging a broken project install or for deliberately using the global one:

```term
$ sous --version
Handing off to the project-level Sous install: v0.2.4
v0.2.4
$ sous --version --verbose
Handing off to the project-level Sous install: v0.2.4
    Project install: /work/app/node_modules/@sous-io/sous
    Invoked install: v0.3.0 at /usr/lib/node_modules/@sous-io/sous
Set SOUS_NO_DELEGATE=1 to run the invoked install instead.
v0.2.4
    Package : @sous-io/sous
    Install : /work/app/node_modules/@sous-io/sous
    Platform: linux-x64
    Node    : v22.21.0
$ SOUS_NO_DELEGATE=1 sous --version
v0.3.0
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
