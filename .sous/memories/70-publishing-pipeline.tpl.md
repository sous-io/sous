Every merge to `main` publishes, through `.github/workflows/publish.yml` (it reads the version,
publishes to npm through trusted publishing, then pushes the matching core recipe to
`sous-io/sous-recipes`). Read the workflow for how the version is chosen. Never write `[skip ci]` or
`chore: release` into an ordinary commit to `main`: the release job treats those as its own commit
and the merge would not release. Renaming `publish.yml` breaks npm's trusted publishing until the
npm setting is changed by hand.

The core recipe (`recipes/core/`) must have exactly the package's version. `pnpm version:sync`
puts them back in step after a version is set by hand.
