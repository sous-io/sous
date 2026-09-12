---
name: qa-remote-dep
description: >-
  Load this skill when a walkthrough asks how a recipe names something it
  depends on in another repository.
---

# Naming what a recipe depends on

Read this recipe's manifest beside this file. It declares two dependencies:

- `workflow/qa-helper`, a sibling in this repository, written as a bare ref.
- `github://sous-io/sous-recipes/workflow/sub-agent-delegation@^1.0`, a recipe
  in another repository, written as a locator whose scheme is the provider.

The last two segments of a locator are always the namespace and the recipe;
everything before them is the repository. A path such as `../qa-helper` is
refused, and so is a short name such as `qa-recipes:workflow/qa-helper`.
