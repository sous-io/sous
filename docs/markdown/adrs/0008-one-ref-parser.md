# ADR 0008: One ref parser, told where the ref came from

**Status:** Accepted, 2026-09-29. Superseded by [ADR 0013](0013-one-ref-resolver.md).

This record amends [ADR 0001](0001-repositories.md) where it defines how a ref is written and read:
the grammar of a dependency, and the rule that a locator's last two path segments are the recipe. The
living answer is [Ref forms](../repositories-file-formats.md#ref-forms). The work is
[gh-123](https://github.com/sous-io/sous/issues/123) (One ref parser for every place a ref is written,
accepting every form).

## Context

A ref was read by several unrelated pieces of code, each accepting a different subset of forms:
`parseRef` for the command line and subscriptions, `parseDependencyRef` for manifests, a hand-rolled
`normalizeRef` in the include resolver that read a locator by taking its last two path segments, and
`key.split("/")[0]` lookups that treated a key's first segment as its namespace. A form one place
accepted, another refused, and the "last two segments" rule could not read a namespace-only locator, a
browser URL or a GitLab nested group. The user ruled that every form should work:

> "every form and format we've discussed should work. We keep looking at solutions until we find the
> best outcome... full stop."
>
>   -- **the user** in an agent session (2026-09-29, quoted in gh-123)

and that one parser need not mean one set of forms everywhere:

> "Centralize" does not necessarily mean "homogenize"; this can be solved via a param"
>
>   -- **the user** in an agent session (2026-09-29, quoted in gh-123)

> "Fine, but `from:` should point to an enum or whatever."
>
>   -- **the user** in an agent session (2026-09-29, quoted in gh-123)

## Decision

- **One function reads every ref**: `parseRef(ref, from = RefSource.CommandLine)` in
  `src/lib/refs/parse.ts`. It recognizes a bare namespace, `namespace/recipe`, `namespace/*`, a `repo:`
  qualifier, a range, a provider-scheme locator for a namespace or a recipe (with or without `/*`), an
  HTTPS URL, a scheme-less host path, an SSH remote, a browser URL from a host's file view, a `.git`
  suffix, GitLab's `/-/` separator and GitLab nested groups. It returns every reading of the input.
- **`RefSource` says where the ref was written**, as a string enum beside `SousScope`: `CommandLine`,
  `Config`, `Manifest` and `Lockfile`. The place decides which forms are allowed, and a refused form is
  an error saying what to write instead: a `repo:` qualifier in a manifest names the locator form, and a
  location in a config file names `sous subscribe`, which adds the repository and records the
  subscription in its short form.
- **Host-specific readings belong to the providers.** The parser takes the host and the path segments
  out of a URL and asks the provider for that host (`RepoProvider.readLocation`) where the repository
  path ends and what the rest names; `formatLocator` prints the canonical locator. Nothing
  host-specific lives in `src/lib/refs/`. GitHub's repository is always two segments; GitLab's ends at
  `/-/` or a `.git` suffix, and otherwise every split is a reading. GitLab's canonical locator always
  carries `/-/`, so it reads one way.
- **A ref is stored and printed as its published identity** (namespace and recipe), never as a folder
  path. Any spelling that settles to one identity is accepted. What sous writes (config layers, the
  lockfile, the index) and prints is always the canonical form.
- **Ambiguous locators are settled at release time.** `sous repo release` fetches, through the provider
  layer, the index of every candidate repository of a dependency that reads more than one way (a GitLab
  nested group), or that names a browser path, and keeps the reading whose index publishes what was
  named. The repository it settled on is recorded in the index, in the version's `dependencies`, beside
  each key the dependency reached. A network failure fails the release; it never falls through to the
  next reading. A genuine tie is an error naming the `/*` spelling for the namespace and the `/-/`
  spelling for the recipe. A dependency that reads one way fetches nothing, so such a repository still
  releases offline.
- **Consumers never probe.** The resolver reads the index's record; failing that, a reading whose
  repository the project already trusts and whose cached index publishes it; failing that, it stops with
  an error listing the readings. A browser path is settled through the `path` each recipe's index entry
  records, once the project has that repository's index.
- **On the command line, a location is settled against trusted repositories.** A location is matched to
  the trusted repository at it by identity, whatever the project calls it, and settled through its
  index. This holds for every command that takes a reference, `sous vars ask` included: the
  repositories a reference searches carry their identity and each recipe's folder
  (`SubscriptionService.cachedReferenceRepos`), and the variables command narrows to what the
  settled repository, namespace or recipe covers. `sous subscribe` runs the trust ceremony first for a location no trusted repository matches;
  when that location reads as several repositories, which one is a question, since nothing may be
  fetched from a repository before it is trusted.
- **Names match exactly first, then ignoring case.** Several matches go to `pickReference`, as any
  ambiguity does. A manifest's names are recorded lowercase; stored keys must already be lowercase.
- **The include resolver takes its scope from the lockfile**, whose holder lists record the key every
  `depends` and `subscribes` entry resolved to, so it never parses a written dependency itself.
- **`parseDependencyRef`, `normalizeRef` and every ad hoc key split are gone.** `splitRecipeKey` and
  `namespaceOfKey` are thin wrappers that read a stored key through `parseRef`.

## Consequences

- A manifest using a URL form, a namespace locator or a GitLab nested group needs this version of sous
  to consume, and a dependency that reads more than one way needs a release by this version to record
  its answer. A consumer meeting one with no record says so and names the spellings that read one way.
- A release of a repository that uses an ambiguous or browser-URL dependency needs the network, and
  fails when a candidate index cannot be read.
- `src/lib/refs/parse.spec.ts` checks every form in every `RefSource`, and the refusals;
  `src/lib/repos/release/settle.spec.ts` checks release-time settling with fake fetches, including a
  network failure and a tie.
