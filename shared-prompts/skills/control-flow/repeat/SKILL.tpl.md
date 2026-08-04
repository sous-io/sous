---
name: repeat
description: >
  Used to send an instruction to the agent and have the agent repeat the instruction back to you
  before acting, to ensure that you and the agent are aligned.
argument-hint: instruction
disable-model-invocation: true
---

New Instruction:
$ARGUMENTS

-

DO NOT ACT, yet. Instead, I want you to repeat the instruction back to me, in your own words and
in a well-structured format so that I know our understandings are aligned. If I am satisfied with
your explanation, I will approve you to begin acting.

You may do a small amount of research before repeating the instruction back to me, if you think
it would allow you to be more precise or accurate in your explanation.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a
template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
