# Recipe Variables

A recipe that needs a value from your project publishes a **variable definition**: a
specification with a name, a type, a question and a set of constraints. You supply an **answer**.
A "question" is only the interactive moment; sous asks one only when a subscribed recipe needs a
variable and nothing in scope answers it, or when the answer in scope no longer fits.

?> This page is about variables that recipes publish. Your project's own `${var}` configuration
variables are a different, older, deliberately ceremony-free system; see
[Variables](config-variables.md) for those. The two never mix.

## Where answers live

Answers are stored in your project's env files, and nowhere else:

| File | Committed | Holds |
|------|-----------|-------|
| `.sous/.env` | yes | Shared answers (`scope: shared`), the team's defaults |
| `.sous/.env.local` | no, gitignored | Machine-specific answers (`scope: local`) and every secret |

Sous edits these files the way a careful person would. Exactly one value line is rewritten or
appended; comments, blank lines, ordering and quoting all survive untouched. A newly added entry
gets a short generated header comment above it saying where the value came from:

```bash
# Set by sous for workflow/task-files: Where should task files live?
# One file per git branch is written here.
# Edit freely; sous only rewrites the value line.
SOUS_VAR_TASK_FILE_ROOT=.sous/tasks
```

Those comments are output only. Sous never reads one back, so editing or deleting a comment
changes nothing, and editing the value line is a perfectly normal way to change an answer.

## The ladder

For each variable, sous generates a list of environment variable names and tries them in order,
most specific first. The first name that holds a value wins.

| Rung | Name | Example | When it applies |
|------|------|---------|-----------------|
| 1. mapping record | whatever the record names | `TEAM_API_URL` | Only when a record exists for this variable |
| 2. recipe scope | `SOUS_VAR_<NAMESPACE>_<RECIPE>_<VARIABLE>` | `SOUS_VAR_WORKFLOW_TASK_FILES_API_URL` | Answers this one recipe's variable and nothing else |
| 3. namespace scope | `SOUS_VAR_<NAMESPACE>_<VARIABLE>` | `SOUS_VAR_WORKFLOW_API_URL` | Answers every recipe in the namespace at once |
| 4. shared scope | `SOUS_VAR_<VARIABLE>` | `SOUS_VAR_API_URL` | Answers every recipe that declares that variable name |
| 5. declared name | the definition's own `env` field | `GITHUB_TOKEN` | How a recipe binds a value the environment already carries |

Read from the bottom up, the ladder is a story about sharing. One `SOUS_VAR_API_URL` answers
every recipe that wants an `apiUrl`, which is what you want most of the time. When two recipes
want the same name and mean different things, move one answer up a rung to the namespace or the
recipe form, and the more specific name wins for that recipe alone. When even that is not enough,
a mapping record settles it.

!> Candidate names are only ever GENERATED and looked up, never parsed back into scopes. The
underscore is both the delimiter and a legal identifier character, so no parse of a name would be
trustworthy: `SOUS_VAR_TASK_FILES_ROOT` could be three different things. Sous therefore builds the
five candidates it knows are correct and asks the environment about each one.

## The three sources, within a rung

Each rung is looked up in three places, in this order:

1. **The real shell environment.** `SOUS_VAR_API_URL=... sous build` beats both files.
2. **`.sous/.env.local`.** Gitignored; your machine, your secrets.
3. **`.sous/.env`.** Committed; the team's shared defaults.

No load ever overwrites a value that is already set, so the first writer wins. This is the same
precedence the rest of sous uses for env files; see
[Discovery and overrides](config-discovery.md).

## Mapping records

A mapping record binds one environment variable, of any name at all, to one fully qualified
variable. It is the top rung and the universal conflict resolver: two recipes wanting the same
name, or a name that already means something else in your environment.

```json
{
  "varMappings": {
    "TEAM_API_URL": "sous-recipes:misc/stuff/apiUrl"
  }
}
```

A target is written `namespace/recipe/variableName`, optionally qualified as
`repo:namespace/recipe/variableName`. Records live under the top-level `varMappings` config key.
Sous writes the ones it creates into `.sous/conf.d/520-var-mappings.json`, replacing that file
in full so each name has exactly one record, and you may hand-write `varMappings` in your primary
config too; the two merge like any other config layer.

You rarely write one yourself, because sous offers one at the moment the conflict appears. When
the name an answer would use already holds a value that does not fit the definition, you are
asked where the answer should go:

```text
SERVICE_TOKEN already holds a value that does not fit serviceToken. Where should this answer go?
  SOUS_VAR_TOOLING_DEPLOY_SERVICE_TOKEN, with a mapping record (recommended)
  SERVICE_TOKEN, replacing what is there
```

Choosing the record writes both the answer under the scoped name and the record binding it, and
the run reports the pair. Where there is no terminal, the record is written, because overwriting
a value something else is already using would be the worse of the two guesses.

## `sous vars`

Lists every variable in play: its name, the recipe that published it, the environment variable
that answered it, the value, and where the value came from. A secret's value is hidden.

```term
$ sous vars
Variable      Recipe               Answered by          Value                     Source
apiUrl        workflow/task-files  SOUS_VAR_API_URL     https://api.example.com   shared scope, the .env file
taskFileRoot  workflow/task-files  SOUS_VAR_TASK_...    .sous/tasks               shared scope, the .env file
serviceToken  tooling/deploy                                                      nothing yet
```

`--file <path>` reads definitions from a standalone definitions file instead of the project's
recipes. The file holds the same `variables:` array a recipe manifest carries, which is how a
project asks questions no recipe publishes yet.

## `sous vars <name>`

Shows one variable in full: its question, its description, the recipe and version that published
it, its constraints, which env file an answer would be stored in, the value in scope, and whether
that value fits the definition. Then it prints every name on the ladder and says which rung
actually answered.

```term
$ sous vars apiUrl
Question:     Where does the API live?
Recipe:       workflow/task-files version 1.2.0 from sous-recipes
Constraints:  must be a URL
Stored in:    .env
Value:        https://api.example.com

Environment variable                     Rung             Status
SOUS_VAR_WORKFLOW_TASK_FILES_API_URL     recipe scope     not set
SOUS_VAR_WORKFLOW_API_URL                namespace scope  not set
SOUS_VAR_API_URL                         shared scope     answered it, from the .env file
```

The name may be the bare variable name or its full `namespace/recipe.name` key, which is what you
use when two recipes publish the same name.

?> One variable cannot be shown this way: a variable literally called `ask`, because
`sous vars ask` is the command below. `sous vars` still lists it.

## `sous vars ask`

Asks the questions the project's definitions imply and stores the answers.

| Invocation | What it does |
|------------|--------------|
| `sous vars ask` | Asks only what is unanswered, or what no longer fits its definition |
| `sous vars ask <name>` | Asks just that one variable, by name or by full key |
| `sous vars ask --all` | Asks every variable again, including the ones already answered |
| `sous vars ask --file <path>` | Reads definitions from a standalone definitions file |
| `sous vars ask --dry-run` | Reports what would be asked and written, without writing anything |

Every run ends with the same three-part report: what was inherited from an answer already in
scope, what was stored and under which name in which file, and what was left unanswered and why.

Subscribing runs the same machinery, so in normal use you rarely invoke `vars ask` by hand;
reach for it after editing an env file, after a recipe upgrade tightened a constraint, or when
you want to re-answer something deliberately with `--all`.

## Without a terminal

Sous never hangs waiting on a prompt it cannot show. A run with no terminal and an unanswered
required variable fails, and the failure names every environment variable that would satisfy it,
most specific first, which is the message a continuous integration log needs to be useful:

```text
One variable still needs an answer, and there is no terminal to ask on.

Set one of the environment variables listed under each variable, or run
'sous vars ask' from a terminal.

  apiUrl (workflow/task-files): Where does the API live?
    SOUS_VAR_WORKFLOW_TASK_FILES_API_URL  (recipe scope)
    SOUS_VAR_WORKFLOW_API_URL  (namespace scope)
    SOUS_VAR_API_URL  (shared scope)
```

Set one of those names as a secret or a variable in your pipeline and the build proceeds. For an
answer the whole team shares and nothing about it is sensitive, committing it to `.sous/.env` is
simpler still: a fresh clone then needs no pipeline configuration at all.

## Where to go next

- [Consuming recipes](repositories-consuming.md): subscribing, building, and what lands where
- [Authoring a repository](repositories-authoring.md): declaring the definitions this page
  resolves
- [Variable definitions](repositories-file-formats.md#variable-definitions): the full field table
- [Command reference](commands.md): every command and flag
