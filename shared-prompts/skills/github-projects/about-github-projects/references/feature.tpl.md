# Feature Issue Structure

Use this structure for user-facing features and enhancements (label: `enhancement`).

## Body Structure

1. **Opening line**: one sentence stating the user-visible outcome.
2. **`## Motivation`**: who wants this and why; the problem it solves. Cite the conversation,
   issue, or usage pain that prompted it.
3. **`## Desired Behavior`**: what the feature does from the user's point of view. Concrete
   invocations, inputs, and outputs beat abstract descriptions; for CLI work, show the intended
   command line and its output.
4. **`## Acceptance Criteria`**: a checklist (`- [ ]`) of observable outcomes that mean "done".
5. **`## Technical Notes`** (optional): implementation leads, constraints, or affected modules.
   Tentative by definition; see Issue Intent vs Technical Implementation in
   `about-github-projects`.

## Conventions

- Keep the title outcome-oriented and free of implementation detail.
- Write bodies in GitHub-flavored Markdown; reference related issues/PRs as `#<number>`.
- Acceptance criteria are the contract; keep them testable and few.

## Example CLI Invocation

```bash
cat <<'MD' | gh issue create --repo {{ githubRepo }} \
  --title "Support X in the Y command" \
  --label enhancement \
  --body-file -
One-line user-visible outcome.

## Motivation
Why this matters.

## Desired Behavior
What it does, with a concrete example invocation.

## Acceptance Criteria
- [ ] Observable outcome one
- [ ] Observable outcome two
MD
```

After creation, add the issue to the board with status Backlog (or Ready if already scoped); see
[Workflow](workflow.md).
