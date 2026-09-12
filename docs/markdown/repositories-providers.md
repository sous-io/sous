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

Each provider declares which of the two features, `fetch` and `submit`, it genuinely answers, and
sous consults that declaration rather than a provider's name. Asking for something outside a
provider's features is refused with a sentence naming it and what it cannot do, never a crash.

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
repository on this machine is machine-specific either way. In a config file that same relative path
is refused outright, because an entry is read from a file that several working directories may run
against; see
[A local repository named by a relative path](repositories-troubleshooting.md#a-local-repository-named-by-a-relative-path).

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

With no provider named and nothing recognizing the host, sous says so and points at the flag:

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
localhost/home/me/projects/my-recipes
```

A local repository's identity uses the host `localhost` and the directory's parent path as its
owner, so a path on disk keys exactly the way a hosted repository does. Identity is then what
every machine-wide thing keys by:

| Keyed by identity | Looks like |
|---|---|
| the store entry | `~/.sous/cache/github.com/sous-io/sous-recipes/<namespace>/<recipe>/<version>/` |
| the cached index | `~/.sous/cache/_indexes/github.com/sous-io/sous-recipes.json` |
| the index sidecar | `~/.sous/cache/_indexes/github.com/sous-io/sous-recipes.meta.json` |
| the lockfile's `identity` field | `github.com/sous-io/sous-recipes` |

A repository's **short name** (`sous-recipes`) is something your project chose, and it keys
nothing shared: two projects may call one repository different things, and two may use one name
for different repositories. Keying by identity is what lets them share one cached copy without
colliding. See [The store on disk](repositories-file-formats.md#sousentryjson-and-the-store).

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

A 401 or 403 says the repository is private or was not authorized, and points at the two sources:

```text
Sous could not fetch the repo index from https://raw.githubusercontent.com/acme/recipes/HEAD/sous.index.json.
  The server answered 403 Forbidden.
  The repository is private or the request was not authorized. Sous uses a token from the
  environment, or from the provider's command line tool when one is installed and signed in.
```

**A recipe's files** come from git itself: a shallow, blobless, sparse clone at the version's
tag, fetching only the blobs inside that one recipe folder. That means git's own credentials
apply, exactly as they would for a manual clone: credential helpers, the SSH agent, proxies and
`insteadOf` rewrites are all inherited from your git configuration, and sous adds nothing of its
own. Cloning a working copy with `sous repo link` works the same way.

?> For a private repository, make sure both halves work. `gh auth login` (or `GITHUB_TOKEN`)
covers the index, and a git credential helper or an SSH key covers the recipe files. A build that
finds the index but cannot clone has only the second half missing.

## Proposing a change

[`sous repo submit`](repositories-authoring.md#contribute-to-someone-elses-repository) validates
your repository, then hands the host-specific mechanics to the provider that owns its `origin`
remote. Providers differ, and sous says so rather than pretending otherwise:

| Provider | Tool | Push permission | Forking | Proposal |
|---|---|---|---|---|
| `github` | `gh` | read from GitHub, so a contributor without it is forked automatically | `gh repo fork`, with a `fork` remote added for you | pull request |
| `gitlab` | `glab` | sous cannot tell, so it pushes to `origin` and says so | not done for you | merge request |
| `local` | none | not applicable | not applicable | not applicable |

**GitLab reports "cannot tell" rather than guessing.** Sous has no cheap, reliable way to ask
whether you may push, and a wrong guess would send you down a fork path this provider cannot
finish. So the submission announces that it could not tell and pushes to `origin` as it stands. If
that push is refused, the command stops at the push step and reports git's own error alongside
everything it had already done; forking the project and pushing there is then a manual route.

**A local repository never submits.** It declares `fetch` only, so `sous repo submit` stops before
anything is written and prints the repository's own contribution route instead:

```text
Error: The 'local' provider cannot propose a change on your behalf.
  This repository asks that changes be sent this way:
    https://github.com/sous-io/sous-recipes/blob/main/CONTRIBUTING.md
```

That second line is the `contribute` field from the repository's `sous.repo.yaml`; sous prints it
whenever a provider cannot carry the proposal, so a contributor is never left without a route. A
manifest that sets none gets "This repository's manifest does not say where to send a change, so
send it the way its maintainers prefer." Set the field in your own repository for the same reason;
see [the repository manifest](repositories-file-formats.md#sousrepoyaml).

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

That block goes at the top level of your primary config or of a `conf.d/` layer of your own; sous
writes its own entries to the `conf.d/500-repos.jsonc` layer it manages. Every key is listed under
[configuration keys](repositories-file-formats.md#configuration-keys).

Everything downstream then works normally: the index is read from that host's own raw endpoint,
`GITLAB_TOKEN` or `glab` supplies the token, and the identity is
`git.example.com/platform/recipes`. Group paths of any depth are preserved, so
`group/subgroup/project` stays one repository rather than being mistaken for a namespace.

`sous repo submit` is the exception: it runs inside the repository checkout and never reads a
project's config, so it picks the provider from the `origin` remote URL alone. A host that does not
begin with `gitlab.` goes unrecognized there, and sous prints the repository's `contribute` pointer.

## The local provider

A repository on this machine is an ordinary directory holding a `sous.repo.yaml`, read through
the `local` provider:

```term
$ sous repo add ../my-recipes --name my-recipes --trust
// sous resolves the path, reads the index and records the absolute form
Repository: my-recipes
Location  : /home/me/Projects/my-recipes
Provider  : local
```

It exists for local development and for tests: authoring a repository, trying a recipe before
publishing it, or running a whole workflow with no network at all. Two details make it behave
like a host rather than like a shortcut.

- The index is read from the **working tree** when `sous.index.json` is there, so an index you are
  still writing is picked up without a commit, and from `git show HEAD:sous.index.json` otherwise.
- A recipe's files come from a clone of the local repository at the version's **tag**, exactly as
  a hosted repository would be fetched, so a version really is the version its tag points at. A
  directory that is not a git repository, or one missing that tag, has no versions to honor, so
  its working tree is copied instead.

!> A local path is added, and therefore trusted, through the same ceremony as a hosted
repository, because its recipes still run on this machine. See [Trust](repositories.md#trust).

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
plugin API, so it can still change shape; what follows is what a new provider writes today. A
provider class extends `ProviderBase`, which carries the plumbing no provider should repeat:
running a subprocess through the injectable runner, checking whether a tool exited cleanly,
capturing its output, finding a host token, and refusing every write-path call by name until a
subclass overrides it. Each member is documented where it lives, in
`src/lib/repos/providers/base.ts`.

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
- [Troubleshooting](repositories-troubleshooting.md): what the errors mean and how to clear them
- [Command reference](commands.md): every command and flag
