# Code blocks

?> This is an example page. It shows fenced code rendering with syntax highlighting; it will be
replaced by real reference content.

Fenced blocks use the same theme-aware editor palette as the code windows in the
[animated introduction](../), so code looks identical across the site in both light and dark
mode. Hover any block for a copy button.

## Shell

```bash
# build, then launch claude with the compiled prompt
xcv build
xcv launch claude -- -c

# inspect the merged config
xcv config get compilation.targets[0].entryPoint
xcv config show | jq '.tools'
```

## JavaScript

```js
export const config = {
  version: 1,
  name: "My Project",
  _env: { userHome: "HOME" },
  _vars: {
    projectRoot: "${sousDir}/..",
    codeBase: "${userHome}/Projects/my-project",
  },
  compilation: {
    targets: [
      {
        entryPoint: "${projectRoot}/prompts/AGENTS.md",
        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],
      },
    ],
  },
};
```

## TypeScript

```typescript
export interface WatchHandle {
  stop(): Promise<void>;
}

export async function watch(paths: string[], debounceMs = 300): Promise<WatchHandle> {
  const watcher = chokidar.watch(paths, { ignoreInitial: true });
  return { stop: () => watcher.close() };
}
```

## JSON

```json
{
  "$schema": "./sous.config.schema.json",
  "version": 1,
  "name": "My Project",
  "_vars": {
    "projectRoot": "${sousDir}/.."
  }
}
```

## YAML

```yaml
version: 1
name: My Project
_vars:
  projectRoot: ${sousDir}/..
compilation:
  targets:
    - entryGlob: ${projectRoot}/prompts/skills/**/*.md
      outputs:
        - destinationDir: ${projectRoot}/.claude/skills
```

## Liquid templates

```liquid
# {{ projectName }}

{% if tool == "claude" %}
Use the Edit tool to modify files.
{% endif %}

{% getFiles models root="{{ projectRoot }}/src/models" include="**/*Model.ts" %}
{% for file in models %}
- {{ file.relPath }}
{% endfor %}
```

## Long lines

Blocks scroll horizontally rather than wrap:

```bash
xcv build --config /very/long/path/to/some/deeply/nested/project/.sous/sous.config.js --rebuild --strict --dry-run
```
