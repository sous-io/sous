{% comment %}
Sous compiles this file into the memories file your coding tool reads in every session
(`.claude/rules/SOUS-MEMORIES.md` for Claude Code, unless memoriesOutputPath says otherwise).
Each line below includes one part:

  @memories/**/*.md    this project's own memories: every markdown file under `.sous/memories/`
  @#memories/**/*.md   the memories of every recipe this project subscribes to

Removing a line removes that part, and moving a line changes the order. Run `sous build` after
a change.
{% endcomment -%}
@memories/**/*.md
@#memories/**/*.md
