# Skill Categories

Sous keeps one canonical list of skill categories. It is a small, closed vocabulary: it exists so
that a skill has an obvious home, so that two people filing similar skills reach for the same
word, and so that a reader scanning a repository can tell what is in it without opening
anything.

| Category | What belongs in it |
|----------|--------------------|
| `reasoning` | How an agent thinks through a problem: decomposition, self-checking, weighing evidence, knowing when it is stuck |
| `planning` | Turning an intent into an ordered plan, and keeping that plan current as the work moves |
| `architecture` | Designing systems and deciding structure: boundaries, dependencies, trade-offs, and how a decision gets recorded |
| `coding` | Writing and changing code: idioms, refactoring, language and framework practice |
| `data-manipulation` | Reading, transforming, querying and reshaping data, in files, databases or streams |
| `research` | Finding things out: searching a codebase, reading documentation, gathering evidence before acting |
| `tool-usage` | Driving a specific tool well: a CLI, a browser, an API, a service that has its own rules |
| `workflow` | The shape of the work itself: tickets, branches, task files, reviews, handoffs between sessions |
| `quality` | Confidence in what was built: tests, linting, review practice, and the standards being upheld |
| `communication` | How an agent talks: writing standards, interaction patterns, asking, reporting, disagreeing usefully |
| `operations` | Running things: builds, releases, deployment, environments, monitoring, recovery |
| `security` | Protecting the system and the people using it: secrets, permissions, supply chain, threat awareness |

## Adding a category is a decision

The list above is the whole list. It is deliberately comprehensive rather than deliberately
small, so that in practice a new skill fits an existing category, and the answer to "which one?"
is a judgment call about the skill rather than an invitation to invent a thirteenth word.

Adding a category is a considered change to a shared vocabulary, never an ad hoc choice made
while filing one skill. A category that gets added because one skill did not obviously fit tends
to attract nothing else, and the list stops being useful the moment it stops being small. If a
skill genuinely resists every category above, that is worth discussing as a gap in the
vocabulary, on its own, before anything is filed.

## Categories as namespaces

The official repository, [`sous-io/sous-recipes`](https://github.com/sous-io/sous-recipes), uses
this list directly: a namespace in that repository is a category from the table above, plus one
extra namespace, `core`, which holds the recipes that teach an agent about sous itself. `core` is
not a skill category. It is a distribution concern, and it exists because those recipes are
auto-subscribed in every project rather than chosen from a catalog.

Your own repository is under no obligation to use these names. Namespaces are just names, and a
team repository whose namespaces are its own product areas is a perfectly good repository. The
list is worth borrowing when what you publish is general-purpose skills that other people will
browse, because a shared vocabulary is what makes browsing work.

?> A namespace subscription gets every recipe in the namespace, including recipes published
later, which is exactly what you want from a coherent category and exactly what you do not want
from a grab bag. That is the practical reason to keep a namespace meaning one thing. See
[Consuming recipes](repositories-consuming.md).

## Where to go next

- [Repositories](repositories.md): the model, and how namespaces fit into it
- [Authoring a repository](repositories-authoring.md): declaring namespaces and filing recipes
  under them
- [Design principles](design-principles.md): the constraints these choices answer to
