# ADR 0042: Retired recipes stay in the index and name their replacements

**Status:** Accepted, 2026-11-20.

The issues are [gh-80](https://github.com/sous-io/sous/issues/80) (the index keeps retired recipes'
published versions), [gh-81](https://github.com/sous-io/sous/issues/81) (builds tell subscribers),
[gh-178](https://github.com/sous-io/sous/issues/178) (a recipe moved to another repository) and
item 2 of [gh-230](https://github.com/sous-io/sous/issues/230) (retiring a recipe breaks
`sous build` on every fresh clone that still pins it).

## Context

`sous repo release` rebuilt the index only from the recipes the repository still listed. A recipe
removed from `sous.repo.yaml` vanished from `sous.index.json`, although its tags stayed. A project
whose lockfile pinned it built only on machines that already held it; on a fresh clone the download
looked the version up in the index, found nothing, and the whole build failed:

> "Error: Sous could not download a recipe this project's subscriptions need.
>   acme/widget: The lockfile pins 'acme/widget' at version 0.1.2 from 'recipes', and that
>   repository's index does not offer it."
>
>   -- gh-230, item 2, "Actual"

Nothing told a subscriber that the recipe was retired, or where it went. The user chose to keep the
versions in the index, and widened the decision:

> "1, but also allow retired recipes to point to recommended replacements, if applicable. Sous will
> prompt the user before following the recommendation."
>
> "bring #178 in. Recipes should be able to suggest zero, one, or more replacements, and they may be
> in other repositories."
>
> "Recipes moved to other repos could specify multiple replacements, all in different
> repositories."
>
>   -- **Luke Chavers** in an agent session (2026-11-20)

## Decision

1. **A recipe is retired when its repository stops listing it.** Nothing else is needed. Every
   version it published stays in the index under a new top-level key, `retired`, beside `recipes`:
   the entries the committed index held, and any other version a tag carries, rebuilt from the
   tag. Tags are never deleted; the tags and the index together are the archive.
2. **`sous.repo.yaml` may name replacements** for a retired recipe, under `retired.<key>.replacements`:
   zero or more refs, each a recipe in this repository (`acme/gadget`) or a locator naming a recipe
   in another one. The release settles each one as it settles a `depends` entry and records its
   key, its repository's identity (for another repository) and the text written.
3. **"Moved" is "retired with replacements".** A recipe that moved to another repository is retired
   in its old one, naming its new home as a replacement. There is no separate "moved" record.
4. **A recipe is published or retired, never both.** A `retired` entry for a recipe `recipes` still
   lists is a release error.
5. **Retired recipes sit outside `recipes`.** A namespace never reaches one, and a new subscription
   cannot find one by name; a subscription or a dependency that already names one still resolves,
   and a pin to one downloads from the folder and tag the index records.
6. **A build warns about every retired recipe it builds**: the pinned version, what uses it and each
   replacement. In a terminal, for a recipe the project subscribes to by name, it offers each
   replacement (one question each, answered no by default); a yes runs `subscription.add`, which
   asks before adding a repository the project has not added, as `sous repo add` does. Once one is
   added, it offers to remove the old subscription, unless a replacement of the same name took its
   place. Without a terminal, on a dry run, or in watch mode it never asks; the warning names the
   commands that make the swap.

The agent's choices the user accepted without objecting: with several replacements the user may
subscribe to any subset; a replacement in a repository the project has not added is named as such,
and sous asks before adding it; without a terminal sous only warns.

## Consequences

- A fresh clone restores a retired recipe's pins. A release by this sous puts back, from its tags,
  any recipe an earlier release dropped.
- A retirement reaches the index with the next release that publishes a version, as every other
  index change does.
- An older sous (0.2.26 or later, which keeps index fields it does not define) reads the new index
  without error and ignores `retired`: it behaves as it did before this change, so a pin to a
  retired recipe still fails to restore there until the project upgrades sous.
- A build in a terminal asks about a retired recipe's replacements on every run until the
  subscription is swapped or removed.
