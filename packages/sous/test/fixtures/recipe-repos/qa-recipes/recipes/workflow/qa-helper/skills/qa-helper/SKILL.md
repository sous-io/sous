---
name: qa-helper
description: >-
  Load this skill when a walkthrough asks what a sibling recipe contributes, or
  when checking that a dependency's own skill reached the project.
---

# The sibling recipe

Subscribing to `workflow/qa-variables` does not install this skill: a build
dependency is readable by the recipe that depends on it, and its files stay out
of the subscriber's output. Subscribe to `workflow/qa-helper` directly to see
this file land.

The shared review steps live beside this skill in `_partials/review-steps.md`,
which is outside the contents patterns on purpose.
