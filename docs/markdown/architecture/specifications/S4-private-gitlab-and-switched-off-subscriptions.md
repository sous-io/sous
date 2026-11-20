# S4: Private GitLab Repositories and Switched-Off Subscriptions

**Status:** Accepted on 2026-10-29. From now on, a
change to this specification is recorded under "Changes".

**Serves:** G1 (encapsulation), G3 (versatility, always), G4 (predictable and
observable), G9 (very fast).

**Shaped by:** L1 (one owner per concern), L2 (one implementation), L5 (everything timed).

## What This Specifies

Four bugs, all fixed as part of the refactor rather than before it, and the way sous reads
repositories that replaces the code behind the first two.

## Where They Came From

An agent working in a project that uses sous reported all four on 2026-10-12, against sous 0.2.33.
That project subscribes to a private GitLab recipe repository, and wants one recipe
(`tool-usage/automated-browser-tasks`) built only on Linux. Until problems 1 and 2 are fixed, every
developer on it runs a script that copies a fresh index into sous's cache, again after every release
of the recipe repository.

## 1. The GitLab index is requested from an address that does not accept a token

Before the refactor, the GitLab provider requests
`https://<host>/<owner>/<name>/-/raw/HEAD/sous.index.json` and sends the token as
`Authorization: Bearer <token>`.

Reported on 2026-10-12, against a private repository with a valid token:

| Request | Result |
| --- | --- |
| `-/raw/HEAD/sous.index.json` with `Authorization: Bearer <token>` | `302` to `https://gitlab.com/users/sign_in` |
| `-/raw/HEAD/sous.index.json` with `PRIVATE-TOKEN: <token>` | `302` to `https://gitlab.com/users/sign_in` |
| `/api/v4/projects/<url-encoded owner/name>/repository/files/sous.index.json/raw?ref=HEAD` with `Authorization: Bearer <token>` | `200` |

## 2. The token is read from `glab` with a subcommand that may not exist

Before the refactor, the GitLab provider runs `glab auth token`. Reported: glab 1.114.0 has no
`auth token` subcommand; it prints the help for `glab auth` and exits `0`, so sous can take help
text as the token. `glab config get token --host <host>` prints only the token.

## The Fix for 1 and 2: How Sous Reads Repositories

`glab` and `gh` are never required to read a repository. They are required only for
`sous repo contribute` and `sous repo submit`. Normal `git` access works without a token; a token is
tried when one is found; and a chain of fallbacks does everything possible to make reading work.

### Read strategies, tried in order

```text
Reading sous.index.json from a repository
  1. HTTP with a token     if a token is found (see "Token sources")
  2. HTTP with no token    public repositories
  3. git                   a shallow, sparse fetch of the one file, using the user's own git
                           credentials (SSH keys, credential helpers)
```

- For GitLab, HTTP requests use the API address, encoding the whole project path so a nested group's
  `/` becomes `%2F`:
  `https://<host>/api/v4/projects/<owner>%2F<name>/repository/files/sous.index.json/raw?ref=HEAD`.
- ETag caching is kept. The GitLab API address sends no ETag for a file; it sends
  `X-Gitlab-Content-Sha256`, which sous keeps in the ETag's place and checks with one `HEAD` request
  to the file's details address (`.../repository/files/<path>?ref=<ref>`), downloading the file only
  when the hash changed.
- A self-managed GitLab may use a port and a sub-path. The HTTPS port stays in the HTTPS and API
  addresses; the SSH URL never carries it, and takes a port only from an SSH URL that names one. A
  sub-path is settled by asking the server once (`<base>/api/v4/version`, root first), remembered per
  host in `$SOUS_HOME/cache/gitlab-instances.json` and reported; a sub-path named in the GitLab
  plugin's `hosts` option is used as given. The API address and the SSH URL leave the sub-path out of
  the project path; the HTTPS clone URL and the identity keep it.
- Each repository provider registers its read strategies, so a plugin can add one (for a host with
  its own authentication, for example).
- Every attempt is timed (L5, everything timed).

### Token sources, tried in order

A missing source is skipped, never required:

```text
  1. GITLAB_TOKEN / GITHUB_TOKEN    the environment
  2. git credential fill            the credential git already stores for https://<host>
  3. glab / gh                      only if installed; for GitLab, glab config get token --host <host>
```

A command's output is accepted as a token only when the command exits `0` and prints exactly one
non-empty line holding no whitespace. This check applies to every provider's token command.

A token the host refuses (`401` or `403`) sends the next source's token to the same strategy; a token
already refused is passed over. When the read then succeeds any way, one warning per command names
where the refused token came from and how to replace it. The token that read the index is also handed
to git for an HTTPS recipe download, as an `http.<origin>/.extraHeader` set through `GIT_CONFIG_*`
environment variables for that one clone, never in a URL; a token from `git credential fill` is not
handed over, because git sends it itself. A clone that fails with the token is tried once more
without it.

### Sous remembers what worked

```jsonc
// $SOUS_HOME/cache/read-strategies.json
{
    "gitlab.com/acme/private-recipes": {
        "strategy": "git",
        "tokenSource": null,
        "lastSuccess": "2026-10-18T22:14:00Z",
        "lastDurationMs": 840,
        "since": "2026-10-15T09:02:00Z",
        "download": { "url": "git@gitlab.com:acme/private-recipes.git", "lastSuccess": "2026-10-18T22:14:02Z", "since": "2026-10-15T09:02:05Z" }
    }
}
```

- Next time, sous tries the remembered strategy first, and walks the rest of the chain only if it
  fails.
- A remembered strategy goes first for `store.strategyMemorySeconds` (seven days by default) from
  `since`, when it became first, however often it works in between. After that the chain's own order
  goes first again, so a better-ranked strategy that works again takes over.
- The clone URL a recipe download worked with is remembered the same way, under `download`, and tried
  first for the same time.
- The remembered choice is per repository, kept in `$SOUS_HOME` (the user's own sous directory), and
  the read strategy is dropped after a read fails; a download that fails every URL drops `download`.

### When everything fails

One error lists each attempt and why it failed, then names the fixes:

```text
Error: could not read gitlab.com/acme/private-recipes.
  HTTP with token      no token found (GITLAB_TOKEN unset; git has no stored credential for gitlab.com)
  HTTP without token   302 to sign-in page: the repository is private
  git                  Permission denied (publickey)
Fix one of these:
  export GITLAB_TOKEN=<a token with read_repository>
  set up git access to gitlab.com (an SSH key, or a credential helper)
```

## 3. A build compiles locked recipes whose subscription is switched off

Reported: with `tool-usage/automated-browser-tasks` shown as enabled "no" by
`sous subscription list`, `sous build` still compiled all four of its skills. The same is reported
for a subscription missing from the merged config on one machine. Before the refactor, the list of
locked recipes starts from every key in the lockfile.

A disabled entry is meant to stay in the config, so the opt-out is visible, and take part in nothing.

Decided:

1. A build compiles only the locked recipes reached from the subscriptions switched on on this
   machine. Outputs of the others are pruned.
2. A switched-off subscription keeps its pins in the committed lockfile, so one developer switching
   a recipe off never removes it for the others.
3. Variables declared only by recipes that are not built are neither asked by `sous vars ask` nor
   required by the build.
4. The build prints one line per skipped recipe, saying why.
5. Subscriptions sous adds itself (`core`) follow the same rules: switched off means skipped, with
   their pins kept.

```text
$ sous build
Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc).
Pruned 4 outputs it had written.
```

## 4. A later config layer cannot switch off a subscription the managed layer lists

Sous writes the project's subscriptions into a config layer of its own,
`conf.d/510-subscriptions.jsonc`, called the managed layer. Before the refactor, the subscription
code re-reads that file after the merge and spreads each entry over the merged entry whole:

```ts
const merged: Record<string, SubscriptionEntry> = {
    ...(enabledSubscriptions(this.settings) as Record<string, SubscriptionEntry>),
    ...this.readSubscriptionEntries(),
};
```

So a layer sorting after 510 that sets
`{ "tool-usage/automated-browser-tasks": { enabled: false } }` has no effect.

Fix: S2 (config building) rules that sous always reads the merged config, which removes the
re-read. After a command writes a managed layer, the config is reloaded.

## Related, Not Proposed

The recipe that prompted problems 3 and 4 declares `x-platforms: [ linux ]` in its manifest, and
nothing in sous reads that key. Fixing 3 and 4 makes a per-machine opt-out work; it does not make
sous skip a recipe by platform on its own.

## Changes

- **2026-11-20:** by the user's rulings on #230 (items 7, 8 and 10), #212 and #213: a refused token
  sends the next source's token and is warned about once; a remembered strategy or clone URL stays
  first for `store.strategyMemorySeconds` (seven days by default); GitLab reads revalidate through
  `X-Gitlab-Content-Sha256`; self-managed GitLab ports and sub-paths are supported; the token sous
  found is handed to git for HTTPS recipe downloads.
