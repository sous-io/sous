# Recipe Variables

A recipe that needs a value from your project publishes a **variable definition**: a name, a type, a question
and a set of constraints. You supply an **answer**. A "question" is only the interactive moment: sous asks one
when a recipe needs a variable and nothing in scope answers it, or when what is there no longer fits.

?> This page is about variables that recipes publish. Your project's own `${var}` configuration variables are
a separate, ceremony-free system; see [Variables](config-variables.md). The two meet in one place only, under
[How a template reads an answer](#how-a-template-reads-an-answer).

## What a definition is, and where it lives

A definition ships inside the recipe that needs it, in its manifest's `variables:` array, so it versions,
resolves, pins and trusts like the rest of the recipe; every field it can carry is listed in
[Variable definitions](repositories-file-formats.md#variable-definitions).

A definition is in play when your lockfile pins the recipe that declares it, whether you subscribed to that
recipe or a dependency pulled it in. A recipe the store does not hold yet contributes nothing rather than
failing, so a fresh clone lists what it can until `sous build` restores the rest.

A project can also ask questions no recipe publishes: write the same `variables:` array into a YAML or JSON
file of your own and point `--file` at it. Every `sous vars` command takes that flag, and the definitions in
it are attributed to a pseudo-recipe in the `local` namespace named after the file, so an `apiUrl` declared in
`questions.yaml` generates `SOUS_VAR_LOCAL_QUESTIONS_API_URL`, `SOUS_VAR_LOCAL_API_URL` and `SOUS_VAR_API_URL`.

!> A definition's `validate.pattern` is a regular expression published by someone else, so sous runs each
match on a worker under a fixed budget of 100 milliseconds, and a pattern that exceeds it fails validation
naming the pattern and the recipe rather than blaming your answer. See
[A variable pattern that runs out of time](repositories-troubleshooting.md#a-variable-pattern-that-runs-out-of-time).

## Answer the questions

Subscribing asks whatever is unanswered, so in normal use you rarely run `sous vars ask` yourself; reach for
it after editing an env file by hand, after an upgrade tightened a constraint, or to re-answer with `--all`.

Every trust decision is settled first: a subscribe resolves the dependency closure and runs the trust
ceremony for each new repository before the first question prints. Questions then run one recipe at a time,
the one you asked for and then each recipe it depends on, with a lead-in and per-recipe counts:

```text
workflow/task-files needs 4 answers, and workflow/sub-agent-delegation, which it depends on, needs 2.

workflow/task-files needs 4 answers before it can be used.
```

Each question prints its header, the publisher's description wrapped to your terminal, and four labeled facts:

```text
Question 1 of 4: taskFileRoot

This recipe mandates the creation of task files that are stored locally and, in
general, should not be committed. The default stores them in the project's .sous
directory; any local path works, relative to the project root or absolute.

    default     : .sous/tasks
    example     : ~/my-task-files
    stored-as   : SOUS_VAR_TASK_FILE_ROOT
    storage-path: /home/you/project/.sous/.env

? Where should task files be stored? (.sous/tasks):
⏎ accept default • ⇥ advanced
```

The legend under the input line names the keys that do anything: Enter accepts what is typed, or the default
when there is one; a list question names the arrow keys instead, and a yes-or-no question the two letters.

### Tab opens the advanced view

Tab works at every kind of question. The advanced view repeats the header and description, prints every fact
about the variable through the renderer `sous vars show` uses, and offers a menu:

```text
[Advanced Variable Settings]

Question 1 of 4: taskFileRoot

    default     : .sous/tasks
    example     : ~/my-task-files
    required-by : workflow/task-files https://example.com/owner/recipes/workflow/task-files
    defined-by  : workflow/task-files https://example.com/owner/recipes/workflow/task-files
    storage-path: /home/you/project/.sous/.env
    stored-as   : SOUS_VAR_TASK_FILE_ROOT
    constraints : • must be a value of the type path (type: path)

? What would you like to do?
  Return to value entry
  Change the storage file
  Change the stored variable name
```

`required-by` names the recipe whose closure pulled this variable in, and spells out the chain when it
arrived through a dependency; `defined-by` names the recipe that declares it. Both carry the location beside
the recipe key, in muted grey: a repository URL, or a filesystem path for a repository on this machine.

**Changing the stored variable name** offers every rung the ladder looks up, sous's choice preselected, plus
a name you type; one the ladder never looks at is bound with a [mapping record](#when-names-collide-mapping-records).

**Changing the storage file** offers the committed `.sous/.env` and the gitignored `.sous/.env.local`.
Pointing a secret, or a variable the publisher declared machine-specific, at the committed file is allowed;
sous says what that means and asks you to confirm, which is informed consent rather than a locked door:

```text
workflow/task-files declared this variable a secret, and .env is committed to git. An answer stored
there enters your project's git history, is pushed with every clone, and is visible to everyone who
can read the repository.

? Store this answer in .env anyway? (y/N)
```

Once anything has changed, the first menu item becomes "Save changes and return to value entry" and a
"Discard changes and return to value entry" item joins it; returning prints the question again with the
updated facts. When an answer is entered, two lines say what was stored and where; a secret is never printed:

```text
    Answer  : SOUS_VAR_TASK_FILE_ROOT=.sous/tasks
    Saved to: /home/you/project/.sous/.env
```

Every run ends with a three-part report: `Answers already in scope:`, `Answers stored:`, `Left unanswered:`.

## Where answers are stored

Answers live in your project's env files, and nowhere else:

| File | Committed | Holds |
|------|-----------|-------|
| `.sous/.env` | yes | Shared answers (`scope: shared`), the team's defaults |
| `.sous/.env.local` | no, gitignored | Machine-specific answers (`scope: local`) and every secret |

Sous edits them the way a careful person would: exactly one value line is rewritten or appended, and
comments, blank lines, ordering and quoting survive untouched. A new entry gets a generated header comment:

```bash
# Set by sous for workflow/qa-variables: Where should a review keep its working files?
# A run writes partial output, logs and diffs somewhere before it assembles the note.
# Edit freely; sous only rewrites the value line.
SOUS_VAR_QA_SCRATCH_DIR=/var/tmp/qa-review
```

Comments are output only; sous never reads one back, and editing the value line changes the answer.

## How sous finds an answer: the ladder

For each variable, sous tries these names in order; the first one holding a value wins.

| Rung | Name | Example | When it applies |
|------|------|---------|-----------------|
| 1. mapping record | whatever the record names | `TEAM_TOKEN` | Only when a record exists for this variable |
| 2. recipe scope | `SOUS_VAR_<NAMESPACE>_<RECIPE>_<VARIABLE>` | `SOUS_VAR_WORKFLOW_QA_VARIABLES_QA_SERVICE_TOKEN` | Answers this one recipe's variable and nothing else |
| 3. namespace scope | `SOUS_VAR_<NAMESPACE>_<VARIABLE>` | `SOUS_VAR_WORKFLOW_QA_SERVICE_TOKEN` | Answers every recipe in the namespace at once |
| 4. shared scope | `SOUS_VAR_<VARIABLE>` | `SOUS_VAR_QA_SERVICE_TOKEN` | Answers every recipe that declares that variable name |
| 5. declared name | the definition's own `env` field | `QA_SERVICE_TOKEN` | How a recipe binds a value the environment already carries |

Read from the bottom up, the ladder is a story about sharing. One `SOUS_VAR_API_URL` answers every recipe
that wants an `apiUrl`, which is what you want most of the time; when two recipes want the same name and
mean different things, move one answer up a rung and the more specific name wins for that recipe alone.

Each rung is looked up in three places, in this order: the real shell environment, then `.sous/.env.local`,
then `.sous/.env`. So `SOUS_VAR_API_URL=... sous build` beats both files, and a machine-specific answer beats
the team's committed default; see [Discovery and overrides](config-discovery.md).

!> Candidate names are only ever GENERATED and looked up, never parsed back into scopes. The underscore is
both the delimiter and a legal identifier character, so no parse would be trustworthy.

`sous vars show` prints the whole ladder, which is the fastest way to see why an answer did or did not take
effect. Here `qaServiceToken` declared `env: QA_SERVICE_TOKEN`, so the bottom rung is that name:

```term
$ sous vars show qaServiceToken
➔ Environment variables sous looks at, most specific first:

  Environment variable                             Rung             Status
  -----------------------------------------------  ---------------  -------------
  SOUS_VAR_WORKFLOW_QA_VARIABLES_QA_SERVICE_TOKEN  recipe scope     not set
  SOUS_VAR_WORKFLOW_QA_SERVICE_TOKEN               namespace scope  not set
  SOUS_VAR_QA_SERVICE_TOKEN                        shared scope     not set
  QA_SERVICE_TOKEN                                 declared name    not set
```

## When names collide: mapping records

A mapping record binds one environment variable, of any name at all, to one fully qualified variable. It is
the top rung and the universal conflict resolver: two recipes wanting the same name, or a name already in use.

You rarely write one by hand, because sous offers one when the conflict appears: when the name an answer
would use already holds a value that does not fit the definition, you are asked where the answer should go:

```text
? SERVICE_TOKEN already holds a value that does not fit serviceToken. Where should this answer go?
> SOUS_VAR_TOOLING_DEPLOY_SERVICE_TOKEN, with a mapping record (recommended)
  SERVICE_TOKEN, replacing what is there
```

Choosing the record writes both the answer under the scoped name and the record binding it, and the run
reports the pair. Where there is no terminal the record is written, since overwriting a value in use is worse.

Sous writes the records it creates into `.sous/conf.d/520-var-mappings.jsonc`, one at a time, so each name
has exactly one. The record's shape and the rest of the managed layers are under
[Configuration keys](repositories-file-formats.md#configuration-keys) and
[Managed config layers](repositories-file-formats.md#managed-config-layers); hand-write one if you prefer.

## See and answer variables from the command line

`sous vars list` prints every variable in play, what answered it, and where the value came from.

```term
$ sous vars list
  Variable        Recipe                 Answered by              Value           Source
  --------------  ---------------------  -----------------------  --------------  --------------------------------
  qaScratchDir    workflow/qa-variables  SOUS_VAR_QA_SCRATCH_DIR  /var/tmp/qa     shared scope, the .env.local file
  qaServiceToken  workflow/qa-variables                           (unanswered)    nothing yet
  qaTaskRoot      workflow/qa-variables  SOUS_VAR_QA_TASK_ROOT    .sous/qa-notes  shared scope, the .env file
```

`sous vars show <name>` prints one variable in full: the question, the publisher's description and example,
the recipe and version that published it, the value in scope and whether it fits, the labeled facts the
advanced view draws, and the ladder table above. The name may be bare or the full `namespace/recipe.name`.

`sous vars ask [name]` asks the questions the definitions imply and stores the answers.

| Invocation | What it does |
|------------|--------------|
| `sous vars ask` | Asks only what is unanswered, or what no longer fits its definition |
| `sous vars ask <name>` | Asks everything the name covers; see the forms below |
| `sous vars ask --repo <name>` | Asks every variable one repository publishes |
| `sous vars ask --namespace <name>` | Asks every variable one namespace publishes |
| `sous vars ask --var <name>` | Asks one variable; repeat the flag for each one |
| `sous vars ask --all` | Asks every variable again, including the ones already answered |
| `sous vars ask --accept-first` | When the name matches several things, takes the first one listed |
| `sous vars ask --file <path>` | Reads definitions from a standalone definitions file |
| `sous vars ask --answer <name>=<value>` | Answers one question ahead of time; repeat it for each answer |
| `sous vars ask --answers-file <path>` | Reads answers from a YAML or JSON file of `name: value` pairs |
| `sous vars ask --dry-run` | Reports what would be asked and written, without writing anything |
| `sous vars ask --non-interactive` | Never asks; fails instead, naming the environment variable or flag that would answer each question |

`<name>` is a reference, resolved like any sous ref; anything larger than a variable asks all its questions:

```bash
sous vars ask taskFileRoot                      # one variable, by the name its recipe gave it
sous vars ask SOUS_VAR_TASK_FILE_ROOT           # the same one, by a name in use that answers it
sous vars ask workflow/task-files.taskFileRoot  # the same one, spelled out in full
sous vars ask task-files                        # every question one recipe asks
sous vars ask sous-recipes                      # every question that repository's recipes ask
```

Matching is case-sensitive, and an environment variable name resolves when a definition declares it or an
env file sets it. `--repo`, `--namespace` and `--var` say which kind is meant, each narrowing what the one
before left, so `sous vars ask --namespace workflow apiUrl` asks about that namespace's `apiUrl` alone. When
a name matches several things, sous lists them and asks; `--accept-first` takes the first, and a run with no
terminal fails naming it.

?> Bare `sous vars` is shorthand for `vars list`, and `sous vars <name>` for `vars show <name>`, which prints
the same report (`vars show` spells the storage path out in full); `sous var list`, `sous var show` and
`sous var ask` work too. A variable named `list`, `show` or `ask` collides with the subcommand, so reach it
the long way: `sous vars show ask`.

### Answering ahead of the questions

`--answer <name>=<value>` answers a question before it is asked and repeats as often as needed, and
`--answers-file <path>` reads the same pairs from YAML or JSON; an `--answer` wins over the same name in the
file. Pair either with `--dry-run` first, as in
`sous vars ask --var qaScratchDir --answer qaScratchDir=/var/tmp/qa-review --dry-run`. Both work the same way
on `sous subscription add`; see [Answer the questions](repositories-consuming.md#answer-the-questions).

Every supplied answer is checked before anything is written, so a value that does not fit fails the run
naming the constraint, and an unknown name fails naming every variable in play. An answer replacing a stored
one is written where that answer lives, and a value the shell supplies is never rewritten:

```text
  Answers stored:
      qaParallelAgents: 4 SOUS_VAR_QA_PARALLEL_AGENTS in .env
                        replaced the answer already there: 99
                        SOUS_VAR_QA_PARALLEL_AGENTS is set in your shell environment and answers
                          this variable first; unset it for the stored answer to take effect
```

## Answer without a terminal

Sous never hangs waiting on a prompt it cannot show; what counts as "no terminal" is listed under
[Run sous in CI, or from an agent](repositories-consuming.md#run-sous-in-ci-or-from-an-agent). Such a run
fails on the unanswered required variables, naming every environment variable that would satisfy each one:

```text
  Error: 1 variable still needs an answer, and there is no terminal to ask on.

  Set one of the environment variables listed under each variable, or run
  'sous vars ask' from a terminal.

    qaTaskRoot (workflow/qa-variables): Where should the review notes be stored?
      SOUS_VAR_WORKFLOW_QA_VARIABLES_QA_TASK_ROOT (recipe scope)
      SOUS_VAR_WORKFLOW_QA_TASK_ROOT (namespace scope)
      SOUS_VAR_QA_TASK_ROOT (shared scope)
```

Set one of those names in your pipeline and the build proceeds. For an answer the whole team shares, and
nothing about it sensitive, committing it to `.sous/.env` is simpler: a fresh clone needs no pipeline setup.

## How a template reads an answer

A build lays the answers into the template scope itself. For every variable a subscribed recipe publishes,
the build walks the ladder above, takes the first value it finds, and adds it to the scope under the
variable's own name. So once `taskFileRoot` is answered, `{{ taskFileRoot }}` renders in the recipe's own
skills and in any template this project compiles, and `${taskFileRoot}` works in `_vars` and every other
config value. Nothing has to be mapped by hand.

The answers sit under your config, not over it. The scope a template renders with is assembled in this
order, each layer overriding the one before:

1. The auto-injected `sous*` variables.
2. The recipe answers, found through the ladder.
3. Your `_env` block.
4. Your `_vars` block.

So a project that already carries an answer in `_vars`, or maps one through `_env`, keeps rendering exactly
what it did; the answer in the env files is simply shadowed, and `sous vars list` still reports it.

When no rung answers, the definition's own `default` is what renders, because the description a publisher
writes promises what the default does. A required variable with no answer and no default renders as an
empty string, and the build says so before it compiles, naming each such variable, the recipe that asks for
it, and `sous vars ask` as the way to answer. The build still succeeds; an unanswered question is
something to tell you about, not a reason to refuse the rest of the project.

?> Two recipes may ask the same question. Their shared answer renders in both, and in your own templates.
When the recipe-scoped name gives one of them a different answer, that recipe's own files render its own
answer while everything else, your templates included, renders the first definition's; `sous vars show`
tells you which names are in play.

An answer is laid in exactly as it is stored: a path stays the string you typed, relative or absolute, and a
number stays text. A template that needs an absolute path from a relative answer composes one under another
name in `_vars`, for instance `taskFileDir: "${sousDir}/../${taskFileRoot}"`.

The `_env` block is still the way to reach any environment variable no recipe asks about.

## Where to go next

- [Consuming recipes](repositories-consuming.md): subscribing, building, and what lands where
- [Authoring a repository](repositories-authoring.md): declaring the definitions this page resolves
- [Troubleshooting](repositories-troubleshooting.md): a question sous cannot ask, a pattern that runs out of time
- [Command reference](commands.md): every command and flag
