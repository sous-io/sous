## Release Posture

Every merge to main publishes, and version numbers are disposable: a gap in the sequence
(a tag that nothing published, a patch that only fixed the pipeline) costs nothing and is
never repaired.

- **Fix forward, never recover.** A failed release is left where it lies; the next merge
  releases the next number and supersedes it. Never re-run, re-tag or delete a tag to make
  the history look tidy.
- **What a failed run leaves behind is already covered.** A tag with no published package is
  harmless. A version on npm with no matching core recipe in the recipe repository is
  covered by the packaged-version overlay (`seedCoreRecipe`, `repos/seed.ts`), which exists
  for exactly that gap, so a project on that version still gets its core skills.
- **The `workflow_dispatch` tag input is a convenience, not a recovery path.** Use it only
  when npm published, the recipe job failed, and no further merge is coming for a while; the
  publish step stands down for a version already on npm, so such a re-run is always safe.
- **A pipeline change is tested by a release.** There is no other way to exercise
  `publish.yml`, so a fix to it is merged on its own and judged by the run it triggers; the
  patch number it consumes is the cost, and it is a cheap one. Read the whole job graph
  before merging a pipeline fix: a condition on one job can hide a condition on the next.
