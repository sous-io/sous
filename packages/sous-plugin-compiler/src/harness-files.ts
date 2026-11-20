/**
 * The files of the targets the merge of the per-harness config builds carried from one harness's
 * build (spec S8, "The Merge", rule 6). The build with no harness never held such a target, so its
 * listing (`compilation.files`) has none of the target's files; the harness's own build listed
 * them. They are taken from that listing, renumbered to the target's place and outputs in the
 * merged config.
 *
 * ```text
 * merged:  targets [ skills/a, skills/skplug (outputs: [{ .claude/skills, harness: claude-code }]) ]
 *          listing { targets: 1 }                 // skills/skplug was never listed here
 * claude-code's build:
 *          targets [ skills/a, skills/skplug (outputs: [.sous/out, { .claude/skills, harness: claude-code }]) ]
 *          files   [ ..., { target: skills/skplug, targetIndex: 1, output: 1, destination: .claude/skills/skplug/SKILL.md } ]
 * result:  files   [ ..., { target: skills/skplug, targetIndex: 1, output: 0, destination: .claude/skills/skplug/SKILL.md } ]
 *          listing { targets: 1, fromHarness: [1] }
 * ```
 */

import { isDeepStrictEqual } from "node:util";
import type { BuiltConfig } from "@sous-io/sous-plugin-api";
import type { CompilationFile, CompilationFileProblem, CompilationSettings, CompilationTarget } from "./types.js";

/** The harness every output of a target is marked with, or `undefined` when they do not all name one. */
function soleHarness(target: CompilationTarget): string | undefined {
    const marks = new Set((target.outputs ?? []).map((output) => output.harness));
    const [mark] = marks;

    return marks.size === 1 && typeof mark === "string" ? mark : undefined;
}

/**
 * `settings` with the files and listing problems of every target its listing missed that a
 * harness's build listed: a target with an `id`, after the listed ones, whose outputs all belong
 * to that harness. Returns `settings` itself when there is none, or when `config` is one harness's
 * build (it has no harness builds of its own to read).
 */
export function withHarnessFiles(settings: CompilationSettings, config: Partial<Pick<BuiltConfig, "forHarness" | "harnesses">>): CompilationSettings {
    const listing = settings.listing;

    if (listing === undefined || typeof config.forHarness !== "function" || (config.harnesses ?? []).length === 0) {
        return settings;
    }

    const files: CompilationFile[] = [];
    const problems: CompilationFileProblem[] = [];
    const fromHarness: number[] = [];

    settings.targets.forEach((target, index) => {
        const harness = soleHarness(target);

        if (index < listing.targets || target.id === undefined || harness === undefined) {
            return;
        }

        const own = config.forHarness!(harness)?.get<Partial<CompilationSettings>>("compilation");
        const ownTargets = own?.targets ?? [];
        const ownIndex = ownTargets.findIndex((candidate) => candidate.id === target.id);

        if (ownIndex === -1 || own?.listing === undefined || ownIndex >= own.listing.targets) {
            return;
        }

        // The merged target holds some of the harness build's outputs; each listed file moves to
        // the place its output has now, and a file of an output left behind is dropped.
        const ownOutputs = ownTargets[ownIndex]!.outputs ?? [];
        const place = (output: number): number => target.outputs.findIndex((kept) => isDeepStrictEqual(kept, ownOutputs[output]));

        for (const file of own.files ?? []) {
            const output = file.targetIndex === ownIndex ? place(file.output) : -1;

            if (output !== -1) {
                files.push({ ...file, targetIndex: index, output });
            }
        }

        for (const problem of own.listing.problems) {
            if (problem.targetIndex === ownIndex) {
                problems.push({ ...problem, targetIndex: index });
            }
        }

        fromHarness.push(index);
    });

    if (fromHarness.length === 0) {
        return settings;
    }

    return {
        ...settings,
        files: [...(settings.files ?? []), ...files],
        listing: { ...listing, problems: [...listing.problems, ...problems], fromHarness },
    };
}
