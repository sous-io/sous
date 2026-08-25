# Task / Tech Debt Issue Structure

Use this structure for engineering tasks, refactors, and tech debt (label: `tech-debt`, or no
type label for ordinary tasks).

## Body Structure

1. **Opening line**: one sentence stating the objective. Outcome-oriented, not a description of
   symptoms.
2. **`## Background & Evidence`**: root cause, history, and evidence. Cite issues, PRs, commits,
   or architecture decisions that explain how the debt formed. Prioritize maintainability or
   scalability pain; route user-facing breakages into bug issues instead.
3. **`## Technical Details`**: systems, modules, and files implicated. Note flags, conventions,
   or infrastructure that shape the work.
4. **`## Proposed Approach / Tasks`**: viable paths without dictating a single solution. Describe
   guardrails and constraints, not an exhaustive implementation plan; the approach is tentative.
5. **`## Related Files`**: every bullet begins with a repo-relative path followed by what likely
   changes there. Link paths to the repository's default branch.

## Conventions

- Draft the title first. Apply the `Tech Debt: ` prefix for debt issues and keep it
  outcome-oriented.
- Write bodies in GitHub-flavored Markdown.
- Reference supporting issues and PRs with the native `#<number>` form so GitHub auto-links them;
  avoid raw link lists in the body.
- Spell out validation expectations at the outcome level ("run the test suite", "exercise the
  CLI"); leave execution details to the assignee.

## Example CLI Invocation

```bash
cat <<'MD' | gh issue create --repo {{ githubRepo }} \
  --title "Tech Debt: Refresh X" \
  --label tech-debt \
  --body-file -
High-level objective.

## Background & Evidence
- Supporting details or links.

## Proposed Approach / Tasks
1. Step one
2. Step two
MD
```

After creation, add the issue to the board with status Backlog (or Ready if already scoped); see
[Workflow](workflow.md).
