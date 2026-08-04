# Automated Browser Tasks

This project can drive a real web browser to accomplish tasks — logging in as
you (using your existing Chrome session), navigating, and extracting data —
**headlessly**, without opening a visible browser or interrupting your work.

**When a task needs a browser and no API or MCP server can do it, this is the
default path.** Do not tell the user to click through a browser manually if it
can be scripted.

**Running a non-mutating task is normal workflow — do it without asking.** A task
that only navigates and reads (extracts data; submits nothing, changes no state,
sends nothing outward) is investigation, the same category as reading a file or
running a query. Running an existing read-only task is not a "manual action" and
not "outward-facing," so it does not need the user's permission — especially while
investigating. Just run it and report what it found; pausing to ask first only
wastes a round trip on a no-risk action. (Creating or modifying a task script, or
running a task that mutates external state, is a separate case — apply normal
judgment there.)

The agent performing the work MUST load the `about-automated-browser-tasks` skill
before writing, running, or modifying any of these tasks. It explains the `ctx`
API, the auth model, and the scriptwriting conventions. The action skills
`create-automated-browser-task`, `update-automated-browser-task`, and
`running-automated-browser-tasks` cover those specific operations (including
exact runner invocation).

Browser runs are slow and multi-step, so they are delegated to a background
sub-agent, per the sub-agent delegation pattern
(`~sous-shared/_partials/sub-agent-delegation.md`). The sub-agent loads the skills
itself and reports the result plus any link or actionable message.

## Available Tasks

{% getFiles browserTasks root=browserAutomationScriptsDir include="*.mjs" import="meta" -%}
{% if browserTasks.size > 0 -%}
{%- for t in browserTasks %}
### {{ t.meta.name }}

{{ t.meta.description }}

- Script: `{{ t.path }}`
{%- if t.meta.params %}
- Parameters:
{%- for p in t.meta.params %}
  - `{{ p[0] }}` ({% if p[1].required %}required{% else %}optional{% if p[1].default %}, default: `{{ p[1].default }}`{% endif %}{% endif %}) — {{ p[1].description | split: ". " | first }}.
{%- endfor %}
{%- endif %}
{% endfor -%}
{% else -%}
_No automation tasks exist yet. Load `create-automated-browser-task` to add one._
{% endif %}
