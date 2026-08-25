# Bug Issue Structure

Use this structure for defects and regressions (label: `bug`).

## Body Structure

1. **Opening line**: one sentence stating what is broken, from the user's point of view.
2. **`## Reproduction`**: numbered, minimal steps. Include exact commands, config, and inputs;
   a reader should be able to reproduce without asking questions.
3. **`## Expected vs Actual`**: what should happen and what happens instead. Paste real output
   (trimmed) in fenced blocks; include error text verbatim so it is searchable.
4. **`## Environment`** (when relevant): version, platform, Node version, anything that gates
   the bug.
5. **`## Evidence & Suspects`** (optional): stack traces, the commit or PR that likely introduced
   it, implicated files with repo-relative paths.

## Conventions

- Titles state the symptom, not the suspected cause ("`xcv prune` deletes fresh outputs when X",
  not "normalize paths in settings.ts").
- One bug per issue; related-but-separate breakage gets its own issue, cross-linked with
  `#<number>`.
- Severity and blast radius go in the opening line or Motivation, not the title.

## Example CLI Invocation

```bash
cat <<'MD' | gh issue create --repo {{ githubRepo }} \
  --title "Symptom-oriented description of the breakage" \
  --label bug \
  --body-file -
One-line statement of the breakage.

## Reproduction
1. Step one
2. Step two

## Expected vs Actual
Expected: ...
Actual: ... (error output goes here, in a fenced block)
MD
```

Note: when the body contains fenced code blocks (it usually should, for verbatim error output),
write the body to a temp file and pass `--body-file <path>` instead of the heredoc, so the
body's fences cannot collide with the surrounding markup.

After creation, add the issue to the board; genuine breakage usually starts at Ready rather than
Backlog. See [Workflow](workflow.md).
