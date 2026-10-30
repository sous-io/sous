# qa-recipes

A throwaway recipe repository used as a test fixture. Nothing here is meant for
real use; every recipe exists to make one part of the repositories system
visible to a test.

It is a scaffold, not a git repository. `src/test/integration/catalog-commands.test.ts`
copies it into a temporary directory, makes that copy a git repository on `main`,
and runs `sous repo release` on it so the versions are published.

## What each recipe is for

| Recipe | What it shows |
|--------|---------------|
| `workflow/qa-variables` | One question of every type sous supports: a string with a default, a path, a URL, a number with a minimum and a maximum, a pick-one list, a yes or no, one machine-local answer and one secret. It also depends on a sibling by a bare ref, and one of its skills is a template that includes a file from that sibling |
| `workflow/qa-helper` | The sibling being depended on. Its `_partials/review-steps.md` sits outside its contents patterns, so it is readable by the recipe that depends on it and is not installed by it |
| `quality/qa-pattern` | One question whose published `validate.pattern` backtracks exponentially, so a test can watch the time budget stop it |
| `quality/qa-remote-dep` | The two spellings of a dependency side by side: a sibling as a bare ref, and a recipe in another repository as a locator URL |

## The two namespaces

`workflow` holds the recipes a test subscribes to; `quality` holds the two that
exercise the edges.

## Editing it

Edit the manifests here, then check them the way a release does:

```bash
cp -r src/test/fixtures/recipe-repos/qa-recipes /tmp/qa-recipes-check
cd /tmp/qa-recipes-check
git init -q -b main && git add -A && git commit -qm "check"
sous repo release --check
```

`--check` reads and validates without writing anything. It reports an out of
date index until the first release, which is expected in a fresh copy.
