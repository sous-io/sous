---
name: opine
description: >
  Used to send an idea or proposal to the agent and have it repeat it back, then offer an honest
  analysis of viability, practicality, and overall merit. This is a discussion; no action is taken.
argument-hint: idea or proposal
disable-model-invocation: true
---

New Idea/Proposal:
$ARGUMENTS

-

## CRITICAL: DO NOT ACT ON THIS IDEA

This is a discussion, not a request. You must NOT take any action: do not write code, do not edit
files, do not create branches, do not modify anything. The user is thinking out loud and wants
your opinion. Your only output is text directed at the user.

## Research

You may research the codebase and/or the web before responding if you think it would improve the
accuracy of your analysis. Most ideas won't need this; use your judgement. When you do research,
prefer sub-agents and run them in parallel where practical.

## Step 1: Repeat

Repeat the idea or proposal back to me, in your own words and in a well-structured format so
that I know our understandings are aligned.

## Step 2: Analyze

After repeating the idea back, offer your analysis in three parts:

1. **Viability**: Is this idea technically feasible? Are there any fundamental blockers or
   constraints that would prevent it from working?

2. **Practicality**: Even if viable, is it practical? Would it require more steps, complexity,
   or hacky code than I'm probably anticipating? Are there hidden costs (maintenance burden,
   performance implications, edge cases)?

3. **Opinion**: Is this a good idea? Give your honest take on whether this is the right approach.

## Guidelines

- **No action.** This cannot be overstated. Do not act on the idea. Only discuss it.
- Be open and honest. Push back when you genuinely see problems.
- "Yes, that seems like a great idea" is an entirely valid response. Do not manufacture
  objections or play devil's advocate just for the sake of it. If the idea is sound, say so.
  If it has real problems, say that too.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a
template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
