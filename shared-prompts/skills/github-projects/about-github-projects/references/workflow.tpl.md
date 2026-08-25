# GitHub Projects Workflow Reference

The board's `Status` field is the state machine. Unlike Jira, GitHub Projects does not gate
transitions: any status can be set from any other status with a single `item-edit` call. The
discipline below is convention, enforced by us, not by the platform.

## Statuses

| Status | Option ID | Meaning |
|--------|-----------|---------|
| Backlog | `{{ githubStatusBacklogId }}` | Captured but not ready to work; may need triage or scoping. Intent may be unclear. |
| Ready | `{{ githubStatusReadyId }}` | Scoped and ready to pick up. |
| In Progress | `{{ githubStatusInProgressId }}` | Actively being worked. |
| In Review | `{{ githubStatusInReviewId }}` | Work complete; PR open or awaiting the user's verification. |
| Done | `{{ githubStatusDoneId }}` | Merged and verified. Also close the issue. |

## Status vs Issue State

The board status and the issue's open/closed state are **independent**:

- Setting status Done does NOT close the issue.
- Closing the issue does NOT change its board status.
- An issue can be open with no board status at all (it was never added to the board).

When completing work, always do both: set status Done AND close the issue. When abandoning an
issue, close it as "not planned" (`gh issue close <n> --reason "not planned"`) and remove it from
the board or set it Done, per the user's preference.

## Setting a Status

Resolve the item ID first (see Board Operations in `about-github-projects`), then:

```bash
gh project item-edit --id <ITEM_ID> \
  --project-id {{ githubProjectId }} \
  --field-id {{ githubStatusFieldId }} \
  --single-select-option-id <OPTION_ID_FROM_TABLE_ABOVE>
```

All three IDs are required; omitting any of them is the most common failure. The command prints
the item JSON on success.

## Common Paths

**Picking up an issue:**
1. Assign to the user: `gh issue edit <n> --repo {{ githubRepo }} --add-assignee {{ githubUserLogin }}`
2. Ensure it is on the board (`item-add` if missing)
3. Set status In Progress (`{{ githubStatusInProgressId }}`)

**Submitting work:**
- Set status In Review (`{{ githubStatusInReviewId }}`) when the PR opens or the work awaits the
  user's verification. Stop there; the user decides when it is done.

**Completing (user has confirmed):**
1. Set status Done (`{{ githubStatusDoneId }}`)
2. Close the issue with a comment linking the merged PR or resolving commit

**Triaging a Backlog issue:**
- Once scoped (the intent is clear and the approach is sketched), set status Ready
  (`{{ githubStatusReadyId }}`).

## Verifying IDs

The option IDs above are compiled from the project config and are stable for the life of the
Status field. If an `item-edit` fails claiming an unknown option, re-discover live values with:

```bash
gh project field-list {{ githubProjectNumber }} --owner {{ githubProjectOwner }} --format json \
  | jq '.fields[] | select(.name == "Status")'
```

If the live values differ from this document, the project config vars are stale; report that to
the user rather than silently using different IDs.
