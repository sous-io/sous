/**
 * PROOF OF CONCEPT for `sous serve`: an in-memory sample template that shows
 * every kind of Liquid section with this project's real variables. Real recipe
 * templates rarely use blocks, so the demo needs one that does.
 */
export const SAMPLE_DISPLAY = "poc-samples/liquid-showcase.tpl.md";

export const SAMPLE_CONTENT = `# Liquid showcase for {{ githubRepo }}

This file is a sample served by the \`sous serve\` proof of concept; it is not on disk.
Put the cursor inside any highlighted section to see its Liquid source, edit it,
then move the cursor out: it re-renders with this project's variables.

{% assign owner = githubRepo | split: "/" | first %}
The project lives in \`{{ sousRootPath }}\` and is owned by **{{ owner | upcase }}**.
It is built with sous {{ sousVersion }}.

## Outward Actions

{% if openPullRequests == "always" %}
Agents in this project open pull requests without asking.
{% else %}
Agents ask before opening a pull request.
{% endif %}

{% assign actions = "pushOwnBranches,openPullRequests,mergePullRequests,releaseOrPublish,sendMessages" | split: "," %}
| Action | Setting |
|---|---|
{% for action in actions -%}
| \`{{ action }}\` | {% case action %}{% when "pushOwnBranches" %}{{ pushOwnBranches }}{% when "openPullRequests" %}{{ openPullRequests }}{% when "mergePullRequests" %}{{ mergePullRequests }}{% when "releaseOrPublish" %}{{ releaseOrPublish }}{% else %}{{ sendMessages }}{% endcase %} |
{% endfor %}

## Project Skills

{% listFiles root=".sous/skills" include="*/SKILL.tpl.md" relative="true" %}

## Branch Names

{% capture branchExample %}{{ featureBranchPrefix }}{{ ticketIdExample }}-fix-a-typo{% endcapture %}
A branch for a ticket looks like \`{{ branchExample }}\`, and its task file lives in
\`{{ taskFileRoot }}/{{ branchExample }}.md\`.
`;
