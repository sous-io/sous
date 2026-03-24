---
name: about-local-skills
description: >
  YOU MUST load this skill when working with skills in .claude/skills/ in the sous project or when the user mentions 
  "local skill" Covers what local skills are, who they serve, and how they differ from "shared skills" in 
  shared-prompts/skills/.
user-invocable: false
---
# Abstract

This "topical skill" is intended to provide information about a specific concept: "local claude skills".

## About Local Skills

The "local skill" is a concept that is unique to the `sous` project. We only have to distinguish between "local"
and "shared" because `sous` is, itself, a provider of skills that can be used by other projects that are managed
by `sous`.

When we refer to a "local skill" or as a skill being "local", we mean that it is a skill that Claude should use
when working on the `sous` project itself. Local skills are not intended to be distributed to other projects;
those skills are called "shared skills" and exist in another location.

## Where Local Skills Exist

Local skills exist in the `sous` repository at `.claude/skills/`.

# Other Skills

## Action Skills

All skills that act upon "local skills" will have "local-skill" in their name. You should find the appropriate
"action skill" for what you want to do, if one exists. If the appropriate action skill does not exist, you should
ask the user if one should be created before continuing.

## Related Skills

This document does not cover the basics of "agent skills", which apply to both "local" and "shared" skills. You MUST load
`about-agent-skills` to learn more about skills and how they're structured.

If you're asked to work on "shared skills" (any skill that exists in `shared-prompts/`) then you MUST load the
`about-shared-skills` skill.
