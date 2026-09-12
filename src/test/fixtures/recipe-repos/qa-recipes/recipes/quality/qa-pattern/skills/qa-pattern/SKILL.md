---
name: qa-pattern
description: >-
  Load this skill when a walkthrough asks what happens to an answer whose
  published validation pattern runs longer than sous is willing to wait.
---

# The pattern that runs too long

This recipe publishes one variable, and its pattern is written badly on purpose.
A recipe is responsible for the patterns it publishes; a person answering a
question is not.

Answer the question with forty `a` characters followed by a `b` to reach the
time budget. Anything shorter matches or fails too quickly to show it.
