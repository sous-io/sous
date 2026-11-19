# ADR 0031: `sous upgrade`, `sous update`, and short aliases

**Status:** Accepted, 2026-11-18.

This record supersedes the command name in [ADR 0011](0011-self-update.md): what it calls `sous update` is
`sous upgrade`. The rest of ADR 0011 stands. The living answer is
[S11](../architecture/specifications/S11-migrations-and-doctor.md) and the
[command reference](../commands.md).

## Context

"Update" meant two things. `sous update` moved sous itself to a newer version, while `sous subscription update`
moved the project's recipes, and `sous recipe update` only printed a plan of that. `sous update` with nothing
after it read as "update everything".

Separately, the refactor meant `sous ns` to work as `sous namespace`, and it did not: `sous ns list` printed
`Error: There is no command "ns".`

## Decision

1. **`sous upgrade` upgrades sous itself**, with every flag `sous update` had.
2. **`sous update [REF]` updates the project's recipes**, with the behavior and flags of `sous subscription
   update`; `--dry-run` prints the plan. `sous subscription update` and `sous recipe update` are aliases of it,
   so `sous recipe update` now performs the update.

   > "rename to `sous upgrade`. `sous update` now becomes the main way to update recipes and the existing
   > commands become aliases."
   >
   >   -- **Luke Chavers** (2026-11-18)

3. **No deprecation step and no notice.**

   > "no one, except me, has ever run `sous update` (or `sous recipes update`) in the history of the earth"
   >
   >   -- **Luke Chavers** (2026-11-18)

4. **Short aliases:** `ns` (namespace), `sub` (subscription), `rc` (recipe), `cfg` (config) for the groups; `ls`
   for `list` and `rm` for `remove` in every group that has them. Each appears in its command's help. The agent
   had recommended leaving out `rc` and `cfg`; Luke chose to include both.
5. **A group's alias is the one way a group gets another word.** It reaches every command in the group and the
   commands' own aliases (`sous ns ls`), and no command spells its group's aliases itself. The reason `ns` failed
   was that it was never declared, while each command spelled its group's plural itself; the group mechanism also
   shared only the group's canonical commands and never showed a group's aliases in help.

## Rejected

- Keeping `sous update` for upgrading sous, with a notice for people typing it out of habit (the agent's
  recommendation), per the quote above.
