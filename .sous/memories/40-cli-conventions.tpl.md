## CLI Conventions

Load `about-sous-cli-conventions` before changing a command, flag, prompt, output or reference
argument. The rules most often broken: help is one sentence naming exactly its thing; names read
like speech, and one fixed choice gets one switch (`--move-includes`, never an enum flag); a
result goes to stdout and everything else to stderr; never prompt without a terminal; where the
code already holds a mechanism, use it instead of building a second one.

## Tests

A test never reads anything outside this repository, and never skips itself because
something is missing. A fixture is either built by the test as it runs or shipped in the
repository in the package's `test/fixtures/` directory (for example `packages/sous-plugin-compiler/test/fixtures/`); a test that would otherwise reach a directory beside
the checkout, a machine-wide store or the user's home directory copies what it needs into a
temporary directory first, and points `SOUS_HOME` at that directory for anything the CLI
writes for itself. A conditional skip hides a failure on every machine but one, so the whole
suite runs the same way on a fresh clone and in continuous integration.
