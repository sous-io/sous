# Providers

A **provider** is everything sous knows about one kind of repository host. It is the only place
a host-specific fact is allowed to live, so every command above it (add, subscribe, build,
release, submit) talks about repositories in the same terms whatever host they live on.

Sous ships three: `github`, `gitlab` and `local`. This page covers how one is chosen for a URL,
what a URL becomes once a provider has taken it apart, how private repositories authenticate,
what each provider can do when you propose a change, and what writing a fourth one involves.

## What a provider answers

Every provider answers the **read path**, which is deliberately small:

- recognize a repository URL as its own;
- take that URL apart into a host, an owner and a name;
- hand back the repository's `sous.index.json`;
- fetch **one** recipe's subtree at one tag.

Nothing there clones a whole repository. A provider that can also carry a contribution answers
the **write path**: report whether its command line tool is installed and signed in, say whether
you may push to the repository itself, fork it onto your account, and open the proposal.

Each provider declares the features it really has, `fetch` and `submit`, and sous consults that
list rather than a provider's name. Asking a provider for something outside its features is
refused with a sentence naming the provider and the feature, never a crash.

## How a URL is matched

When you name a repository, sous tries each provider in turn (`github`, then `gitlab`, then
`local`) and the first one that recognizes the URL handles it.

| Provider | Recognizes |
|---|---|
| `github` | any URL whose host is `github.com` |
| `gitlab` | any URL whose host is `gitlab.com`, or whose host begins with `gitlab.` |
| `local` | an absolute filesystem path, or the same path in `file:///...` form |

Three spellings of a hosted URL are all understood, because all three are what people paste:

```text
https://github.com/sous-io/sous-recipes
git@github.com:sous-io/sous-recipes.git
ssh://git@github.com/sous-io/sous-recipes
```

A trailing slash and a trailing `.git` are dropped before anything else happens, and the scheme
and the host are lowercased. Everything between the host and the last segment is the owner, so
a GitLab group path of any depth (`group/subgroup/project`) is carried whole.

`local` is tried last and matches only a path, so it can never intercept a hosted URL. A path
you type relative (`../my-recipes`, `~/recipes`, `.`) is expanded and resolved against your
working directory before any provider sees it, and the absolute form is what gets stored; a
repository on this machine is machine-specific either way.

### Naming a provider explicitly

`sous repo add --provider <id>` (and the `provider:` key on a repository entry) names the
provider outright. That is what a self-hosted instance behind an unfamiliar host name needs:

```bash
sous repo add https://git.example.com/team/recipes --provider gitlab
```

A named provider is honored for any host nobody recognizes. It is refused only when a
**different** provider plainly owns the URL, because that is a contradiction rather than a hint:

```text
Error: The gitlab provider does not handle https://github.com/sous-io/sous-recipes; that is a
  github URL, which the github provider handles.
  Drop '--provider' and let sous work it out, or name 'github'.
```

With no provider named and no provider recognizing the host, sous says so and points at the flag
that resolves it:

```text
Error: Sous does not recognize the host in the repository URL
  https://git.example.com/team/recipes.
  Sous ships these providers: github, gitlab, local. For a self-hosted instance, name the
    provider that host runs on the repository entry, as in 'sous repo add
    https://git.example.com/team/recipes --provider <provider>'.
```

`sous repo list` shows which provider each trusted repository resolved to:

```text
Repository    Provider  Origin    Linked      Recipes  URL
------------  --------  --------  ------  -----------  ---------------------------------------
qa-recipes    local     user      no                0  /home/me/Projects/qa-recipes
sous-recipes  github    built in  no      not fetched  https://github.com/sous-io/sous-recipes
```

## Repository identity

Canonicalizing a URL produces the repository's **identity**, `<host>/<owner path>/<name>`,
lowercased and with any `.git` suffix gone:

```text
github.com/sous-io/sous-recipes
gitlab.example.com/group/subgroup/project
localhost/home/me/Projects/my-recipes
```

A local repository's identity uses the host `localhost` and the directory's parent path as its
owner, so a path on disk keys exactly the way a hosted repository does.

Identity is what every machine-wide thing keys by:

| Keyed by identity | Looks like |
|---|---|
| the store entry | `~/.sous/cache/github.com/sous-io/sous-recipes/<namespace>/<recipe>/<version>/` |
| the cached index | `~/.sous/cache/_indexes/github.com/sous-io/sous-recipes.json` |
| the index sidecar | `~/.sous/cache/_indexes/github.com/sous-io/sous-recipes.meta.json` |
| the lockfile's `identity` field | `github.com/sous-io/sous-recipes` |

A repository's **short name** (`sous-recipes`) is something your project chose, and it keys
nothing shared: two projects may call the same repository different things, and two projects may
use the same name for different repositories. Keying by identity is what lets those projects
share one cached copy without colliding. See
[The store on disk](repositories-file-formats.md#the-store-on-disk).

Canonicalizing also produces the two clone URLs sous hands to git, `https://<host>/<owner>/<name>.git`
and `git@<host>:<owner>/<name>.git`. For the `local` provider the HTTPS slot carries the
absolute directory, because that is what git is given when a recipe is fetched.

?> A published manifest names a dependency in another repository by a **locator URL** whose
scheme is the provider's identifier: `github://sous-io/sous-recipes/workflow/sat@^1.1`. A first
segment containing a dot is read as the host, so `gitlab://gitlab.example.com/group/project/ns/recipe`
addresses a self-hosted instance; without one, the provider's public host is assumed. `local://`
is refused, because a path on your disk is not a published location. The grammar is in
[Dependencies named by location](repositories-file-formats.md#dependencies-named-by-location).

## Private repositories

Sous reads a repository in two very different ways, and they authenticate differently.

**The index** is one plain HTTPS GET of a raw file, carrying a bearer token when sous has one:

```text
https://raw.githubusercontent.com/<owner>/<name>/HEAD/sous.index.json
https://<gitlab host>/<owner>/<name>/-/raw/HEAD/sous.index.json
```

A token is looked for in two places, in this order:

1. the environment: `GITHUB_TOKEN` for GitHub, `GITLAB_TOKEN` for GitLab;
2. the host's own command line tool, `gh auth token` or `glab auth token`, when it is installed
   and signed in.

Neither is required. A public repository needs no token at all, and a missing `gh` or `glab` is
never an error on the read path; sous simply fetches without one. When the host refuses, the
error says which of the two situations you are in:

```text
Sous could not fetch the repo index from https://raw.githubusercontent.com/acme/recipes/HEAD/sous.index.json.
  The server answered 404 Not Found.
  Either the repository publishes no sous index yet, or the URL names a repository that does
  not exist.
```

A 401 or 403 says the repository is private or the request was not authorized, and names the two
token sources.

**A recipe's files** come from git itself: a shallow, blobless, sparse clone at the version's
tag, fetching only the blobs inside that one recipe folder. That means git's own credentials
apply, exactly as they would for a manual clone: credential helpers, the SSH agent, proxies and
`insteadOf` rewrites are all inherited from your git configuration, and sous adds nothing of its
own. Cloning a working copy with `sous repo link` works the same way.

?> The practical consequence: for a private repository, make sure both halves work. `gh auth
login` (or `GITHUB_TOKEN`) covers the index, and a git credential helper or an SSH key covers
the recipe files. A build that finds the index but cannot clone has only the second half
missing.

## Proposing a change

[`sous repo submit`](repositories-authoring.md#contribute-to-someone-elses-repository) validates
your repository, then hands the host-specific mechanics to the provider that owns its `origin`
remote. Providers differ, and sous says so rather than pretending otherwise:

| Provider | Tool | Push permission | Forking | Proposal |
|---|---|---|---|---|
| `github` | `gh` | read from GitHub, so a contributor without it is forked automatically | `gh repo fork`, with a `fork` remote added for you | pull request |
| `gitlab` | `glab` | sous cannot tell, so it pushes to `origin` and says so | not done for you | merge request |
| `local` | none | not applicable | not applicable | not applicable |

Two of those rows are worth reading carefully.

**GitLab reports "cannot tell" rather than guessing.** Sous has no cheap, reliable way to ask
whether you may push, and a wrong guess would send you down a fork path this provider cannot
finish. So the submission announces that it could not tell, pushes to `origin` as it stands, and
`sous repo submit` asks you to fork the project and push there yourself if that push is refused.

**A local repository never submits.** It declares `fetch` only, so the write path is refused by
name:

```text
Error: The 'local' provider does not support the 'submit' feature, so sous cannot propose a
  change to it.
  A provider answers only what its features promise; this one promises 'fetch'.
```

Whenever a provider cannot carry the proposal, sous prints the `contribute` pointer from the
repository's `sous.repo.yaml`, so a contributor is never left without a route:

```yaml
contribute: https://github.com/sous-io/sous-recipes/blob/main/CONTRIBUTING.md
```

Set that field in your own repository for the same reason; see
[the repository manifest](repositories-file-formats.md#sousrepoyaml-the-repository-manifest).

## Self-hosted GitLab

A self-hosted instance needs no special configuration beyond being recognized. A host that
begins with `gitlab.` is matched automatically; any other host name is matched by naming the
provider once, on the repository entry:

```jsonc
{
  "repos": {
    "team-recipes": {
      "url": "https://git.example.com/platform/recipes",
      "provider": "gitlab"
    }
  }
}
```

Everything downstream then works normally: the index is read from that host's own raw endpoint,
`GITLAB_TOKEN` or `glab` supplies the token, the identity is `git.example.com/platform/recipes`,
and `sous repo submit` opens a merge request there. Group paths of any depth are preserved, so
`group/subgroup/project` stays one repository rather than being mistaken for a namespace.

## The local provider

A repository on this machine is an ordinary directory holding a `sous.repo.yaml`, read through
the `local` provider:

```term
$ sous repo add ../my-recipes --name my-recipes --trust
// sous resolves the path, reads the index and records the absolute form
Repository: my-recipes
Provider  : local
```

It exists for local development and for tests: authoring a repository, trying a recipe before
publishing it, or running a whole workflow with no network at all. Two details make it behave
like a host rather than like a shortcut.

- The index is read from the **working tree** when `sous.index.json` is there, so an index you
  are still writing is picked up without a commit, and from `git show HEAD:sous.index.json`
  otherwise.
- A recipe's files come from a clone of the local repository at the version's **tag**, exactly as
  a hosted repository would be fetched, so a version really is the version its tag points at. A
  directory that is not a git repository, or one missing that tag, has no versions to honor, so
  its working tree is copied instead.

!> Trust semantics are identical to a hosted repository. A local path is added, and therefore
trusted, through the same ceremony, because the recipes in it still run on this machine. "It is
already on my disk" is not a reason to skip the question. See [Trust](repositories.md#trust).

A path that is not a repository is explained as a path mistake rather than as a provider
failure, naming what you typed, what sous resolved it to, and what it expected to find:

```text
Error: There is no directory at './nope'.
  Sous read that as the path /home/me/Projects/my-project/nope, and nothing is there.
  A repository on this machine is a directory holding a 'sous.repo.yaml' file at its root.
  Check the path, or create one with 'sous repo init'.
```

For editing a repository you already subscribe to, reach for
[`sous repo link`](repositories-authoring.md#edit-a-repository-in-place) instead; it redirects
one repository's resolution at a working copy without changing what your project subscribes to.

## Adding a provider

Adding a provider is one file plus one line. The interface is internal for now, not a published
plugin API, so it can still change shape; what follows is what a new provider writes today.

A provider class extends `ProviderBase` (`src/lib/repos/providers/base.ts`), which carries the
plumbing no provider should repeat:

| Inherited member | What it does |
|---|---|
| `runCommand(command, args, options)` | runs a subprocess through the injectable runner and returns its code, stdout and stderr; a command that cannot start comes back as exit code 127 |
| `commandSucceeds(command, args, options)` | true when the command exited zero, for checks whose answer is the exit code (`auth status`) |
| `capturedOutput(command, args, options)` | the command's trimmed stdout, or undefined when it failed or is not installed |
| `findToken(envName, args, options)` | the environment variable first, then the provider's own tool; undefined is a normal answer |
| `authStatus`, `canPush`, `fork`, `proposeChange` | default to a refusal naming the provider and the `submit` feature, so a caller that skips the feature check gets a sentence rather than a type error |
| `unsupported(feature, what)` | builds that refusal, listing what the provider does promise |

The subclass supplies the rest:

- `id`, the identifier a repository entry and a locator scheme use;
- `features`, the ones it genuinely answers (`fetch`, and `submit` only if all four write calls
  are real);
- `matches(url)` and `canonicalize(url)`, the URL half;
- `fetchIndex(repo, options)` and `fetchRecipeTree(repo, recipePath, tag, destDir, options)`, the
  read half;
- `cli` and `proposalNoun` when it submits, so messages can name the tool and call a proposal
  what the host calls it;
- overrides of the four write-path calls when it submits.

Every call takes an options object carrying the testing seams (`cwd`, `env`, `fetchImpl`, `run`),
which is why no provider reaches for `spawn` or the global `fetch` directly and no test in this
layer touches the network. The last change is adding the class to the built-in provider list in
`providers/index.ts`; nothing above the provider layer learns its name.

## Where to go next

- [Repositories](repositories.md): the model, trust, and the lockfile
- [Consuming recipes](repositories-consuming.md): adding, subscribing and building
- [Authoring a repository](repositories-authoring.md): releasing and contributing
- [Repository file formats](repositories-file-formats.md): every manifest, index and lockfile
  schema
- [Command reference](commands.md): every command and flag
