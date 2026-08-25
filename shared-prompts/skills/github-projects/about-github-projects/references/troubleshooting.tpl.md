# GitHub CLI Troubleshooting

## Missing `project` Scope

Board commands (`gh project ...`) fail with:

```
error: your authentication token is missing required scopes [read:project]
```

The fix is user-interactive (browser device flow) and cannot run inside an agent session. Ask the
user to run this in a regular terminal:

```bash
gh auth refresh -s project -h github.com
```

Note the `-h github.com`: without a TTY, `gh auth refresh` demands an explicit hostname. Verify
afterwards with `gh auth status` (the scope list should include `project`).

## Wrong Account

`gh auth status` shows every logged-in account; only the **active** one is used. Confirm the
active account is `{{ githubUserLogin }}` before writes. Switch with
`gh auth switch -u {{ githubUserLogin }}` if needed.

## `item-edit` Fails or Does Nothing

- All three IDs are required together: `--id` (item), `--project-id`, `--field-id`, plus
  `--single-select-option-id` for status. Omitting one produces an unhelpful flag error.
- The item ID (`PVTI_...`) is per-board and is NOT the issue number or node ID; resolve it via
  `item-list` (see Board Operations in `about-github-projects`).
- If the option ID is rejected, the config vars may be stale; re-discover with
  `gh project field-list` per [Workflow](workflow.md) and report the mismatch to the user.

## `item-list` Misses Items

`gh project item-list` returns 30 items by default. Always pass `--limit 200` (or higher) before
concluding an issue is not on the board.

## Interactive Prompts in Non-Interactive Runs

`gh` falls back to interactive prompts when required flags are missing (e.g. `gh issue create`
with no `--title`), which hangs or fails in an agent session. Always pass every required flag
explicitly. For issue bodies, pipe Markdown via `--body-file -`.

## Rate Limits on GraphQL

`gh project` subcommands use the GraphQL API. Batch reads (one `item-list` filtered with `jq`
beats one call per issue) and avoid polling loops.
