/**
 * The content kinds Claude Code's part of sous owns and responds to (specs 01 and 11):
 *
 * - `claude-code-plugin`: a Claude Code plugin folder. Each folder directly under the fixed part of
 *   an `include` pattern is one plugin, written to Claude Code's skills directory under the name
 *   the recipe gives the folder: `plugins/session-harness/...` becomes
 *   `.claude/skills/session-harness/...`, where Claude Code loads it as a plugin.
 * - `claude-code-agent`: agent files, written to `.claude/agents/`, keeping their sub-folders:
 *   `agents/review/security.md` becomes `.claude/agents/review/security.md`.
 *
 * ```yaml
 * contents:
 *   - kind: claude-code-plugin
 *     include:
 *       - plugins/**
 *   - kind: claude-code-agent
 *     include:
 *       - agents/**\/*.md
 * ```
 *
 * A file whose name holds `.tpl.` is rendered as a template (and loses `.tpl.` from its name);
 * any other file is written as it is. Every output is marked with the harness `claude-code`, so only
 * Claude Code's config build supplies it (S8). Inline content (`{ $inline, path }`) is written from
 * a `content` target.
 */

import path from "node:path";
import type { ConfigBuilder, ContributorDefinition, ServiceReader } from "@sous-io/plugin-api";
import type { CompilationTarget } from "@sous-io/plugin-compiler/types";
import type { ActiveRecipeContent, ContentKindEntity, RecipesContents } from "@sous-io/plugin-recipes/types";
import { HARNESS_ID } from "./harness.js";
import { outputDirectory, SKILLS_DIRECTORY } from "./targets.js";
import type { ClaudeCodePluginOptions } from "./types.js";

/** The kind of a Claude Code plugin folder. */
export const PLUGIN_KIND = "claude-code-plugin";

/** The kind of a Claude Code agent file. */
export const AGENT_KIND = "claude-code-agent";

/** Where Claude Code reads a project's agents from, under the project root. */
export const AGENTS_DIRECTORY = ".claude/agents";

/** The contributor's id. */
export const KINDS_CONTRIBUTOR = "claude-code/kinds";

/** The two kinds, as `content-kind` entities. */
export const CONTENT_KINDS: readonly ContentKindEntity[] = [
    {
        id: PLUGIN_KIND,
        description:
            "A Claude Code plugin folder (one holding .claude-plugin/plugin.json): each folder directly under the include pattern's fixed part is written to .claude/skills/<folder>, for Claude Code only.",
    },
    {
        id: AGENT_KIND,
        description: "Claude Code agent files (Markdown with frontmatter), written to .claude/agents/ with their sub-folders kept, for Claude Code only.",
    },
];

/**
 * The compilation targets for one kind's content: one per file, written under `directory` at the
 * file's path from its include pattern's fixed part.
 *
 * ```ts
 * // a/plugins/session-harness/hooks/hooks.json, include "plugins/**", directory "${projectRoot}/.claude/skills"
 * // -> { id: "claude-code-plugin/a/session-harness/hooks/hooks.json", entryPoint: ".../hooks.json",
 * //      globBase: ".../a/plugins", origin: { plugin, recipe: "a" },
 * //      outputs: [{ destinationDir: "${projectRoot}/.claude/skills", harness: "claude-code" }] }
 * ```
 */
export function contentTargets(kind: string, contents: readonly ActiveRecipeContent[], directory: string, plugin: string): CompilationTarget[] {
    const targets: CompilationTarget[] = [];

    for (const content of contents) {
        for (const file of content.files) {
            const fromBase = path.relative(file.base, file.file).split(path.sep).join("/");
            const id = `${kind}/${content.recipe}/${fromBase}`;
            const origin = { plugin, recipe: content.recipe };

            if (fromBase === "" || fromBase.startsWith("../")) {
                continue;
            }

            if (file.content !== undefined) {
                targets.push({
                    id,
                    content: inlineTemplate(file.content, fromBase),
                    origin,
                    outputs: [{ destinationFile: `${directory}/${withoutTpl(fromBase)}`, harness: HARNESS_ID }],
                });
                continue;
            }

            targets.push({ id, entryPoint: file.file, globBase: file.base, origin, outputs: [{ destinationDir: directory, harness: HARNESS_ID }] });
        }
    }

    return targets;
}

/** A path with `.tpl.` taken out of its file name, as the compiler names a rendered template's output. */
function withoutTpl(relative: string): string {
    const name = path.posix.basename(relative);

    return name.includes(".tpl.") ? path.posix.join(path.posix.dirname(relative), name.replace(".tpl.", ".")) : relative;
}

/**
 * Inline content as a `content` target's template. The compiler renders every `content` source as
 * Liquid, but only a `.tpl.` path is a template, so other content is wrapped in `{% raw %}`.
 */
export function inlineTemplate(content: string, virtualPath: string): string {
    return path.posix.basename(virtualPath).includes(".tpl.") ? content : `{% raw %}${content}{% endraw %}`;
}

/** Adds the compilation targets for both kinds. */
export function contributeKinds(config: ConfigBuilder, contents: Pick<RecipesContents, "of">, plugin: string): void {
    const options = config.options<ClaudeCodePluginOptions>() ?? {};
    const list = config.atPath("compilation.targets");
    const plugins = contentTargets(PLUGIN_KIND, contents.of(config, PLUGIN_KIND), outputDirectory(options.skillsDirectory ?? SKILLS_DIRECTORY), plugin);
    const agents = contentTargets(AGENT_KIND, contents.of(config, AGENT_KIND), outputDirectory(AGENTS_DIRECTORY), plugin);

    for (const target of [...plugins, ...agents]) {
        list.appendValue(target);
    }
}

/** The contributor. `recipes.contents` is read through the builder, so a change re-runs it. */
export function kindsContributor(plugin: string, services: ServiceReader): ContributorDefinition {
    return {
        id: KINDS_CONTRIBUTOR,
        contribute: (config) => contributeKinds(config, services.get("recipes.contents"), plugin),
    };
}
