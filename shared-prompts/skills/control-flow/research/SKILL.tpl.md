---
name: research
description: Run a research task using background sub-agents
user-invocable-only: true
arguments-hint: what to research via background subagents
---

Have a background sub-agent do the following:
$ARGUMENTS

## Prefer Parallelism

If possible, practical, and reasonable, break the task into multiple parts and assign each part to a sub-agent.
Running background sub-agents in parallel usually makes things go much faster. Don't break tiny tasks up, though.

Batch the independent dispatches into one message so they run at once. Opus by default; Sonnet only
for rote extraction.

## Sub-Agent Prompts

Per the sub-agent delegation pattern (`~sous-shared/_partials/sub-agent-delegation.md`), each prompt
must be self-contained: the question to answer, the
paths/IDs/facts needed, which skills to load, and the shape of the answer wanted. Sub-agents start
fresh and cannot see this conversation.

Each returns a concise summary, not a file dump. Do not fabricate or predict a pending result; wait
for the notification. Synthesis and reporting to the user are orchestrator-only.

## Source for this Skill

This skill was pulled from the `sous` project's "shared skills" library. It was compiled from a
template and the output file should not be edited directly.

- Source Path: {{ sousTemplatePath }}
