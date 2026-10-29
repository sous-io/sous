# @sous-io/repository-hosts

What the `repository-host` plugins (`plugin-github`, `plugin-gitlab`, `plugin-local`) share, so each
part has one implementation (L2). Not a plugin: a library, like `documents`.

- URLs: `splitRepoUrl`, `canonicalRepository`, `readingsAfterRepository`, `formatHostedLocator`.
- Token sources (S4): `envTokenSource`, `gitCredentialTokenSource`, `cliTokenSource`, and
  `tokenFromOutput`, the one-line check every token command's output passes.
- Read strategies (S4): `httpReadStrategy` (through `host.http`, redirects seen, ETags sent),
  `gitReadStrategy` (through `git.runner.readRemoteFile`).
- Trying the strategies in order, remembering what worked and the combined error are not here:
  `recipes.index-cache` (plugin-recipes) owns them and reads every host's `readStrategies` and
  `tokenSources`. Token sources here also offer `find` (with a reason, `GITLAB_TOKEN unset`) and
  `fix` (`export GITLAB_TOKEN=<...>`), which that chain may use for S4's exact message.
- `fetchRecipeTree`: one recipe folder at one tag, by a shallow sparse clone.
- `runCli`, `cliJson`, `cliAuthStatus`: driving `gh` or `glab`, needed only to propose changes.
- `@sous-io/repository-hosts/testing`: stand-ins for `host.http` (recorded responses),
  `host.processes`, `git.runner`, `host.sous-home`, the plugins a host plugin depends on, and
  `firstToken`/`readWith` for running a host's sources and strategies one at a time.
