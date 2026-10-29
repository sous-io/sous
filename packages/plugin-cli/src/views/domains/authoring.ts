/**
 * The views of plugin-authoring's intents: `repo release`, `repo submit`, `repo contribute` and
 * `repo init` (ported from today's `src/commands/repo/{release,submit,contribute,init}.ts`).
 *
 * Their handlers already tell the story as it happens, through the chain's reporter: the checks, the
 * plan, every step, the changelog, the proposal's status and what to do next. A view adds only what
 * the reporter never said, so nothing prints twice: `repo release` and `repo init` add nothing, and
 * `repo submit` adds the facts block about the proposal that today's command closed with.
 */

import type { CliViewContext, CliViewEntity } from "../../types.js";
import { BULLET } from "../text.js";

/** The part of a proposal the views read. */
interface ProposalFacts {
    readonly url?: string;
    readonly title: string;
}

/** The part of a `repo.submit` result the view reads. */
export interface SubmitResultShape {
    readonly repo: string;
    readonly branch: string;
    readonly fromFork: boolean;
    readonly dryRun: boolean;
    readonly outcome: "created" | "updated" | "unchanged" | "status" | "cancelled";
    readonly host?: string;
    readonly proposalNoun: string;
    readonly baseBranch?: string;
    readonly pushedTo?: string;
    readonly proposal?: ProposalFacts;
    readonly title?: string;
    readonly committedPaths?: readonly string[];
}

/** The part of a `repo.contribute` result the view reads. */
export interface ContributeResultShape {
    readonly stage: "linked" | "submitted" | "finished";
    readonly link?: unknown;
    readonly submit?: SubmitResultShape;
    readonly unlink?: unknown;
    readonly dryRun: boolean;
    readonly completed: readonly string[];
}

/**
 * `repo submit`: the proposal it opened, updated or would open, as a key and value block. The
 * changelog, the status and the closing sentence were reported as the run went, and a status look-up
 * or a cancelled run reported everything there was to say.
 *
 * ```text
 * ▶ The pull request that was opened:
 *
 *     Provider      : github
 *     Repository    : acme/recipes
 *     Branch        : fix-typo
 *     Target branch : main
 *     Pushed to     : origin
 *     Through a fork: false
 *     Address       : https://github.com/acme/recipes/pull/7
 * ```
 */
export function submitView(result: SubmitResultShape, view: CliViewContext): string | undefined {
    if (result.outcome === "status" || result.outcome === "cancelled") {
        return undefined;
    }

    const out = view.printer();
    const noun = result.proposalNoun;
    const heading =
        result.outcome === "created"
            ? result.dryRun
                ? `The ${noun} this would open`
                : `The ${noun} that was opened`
            : result.dryRun
              ? `The ${noun} this would update`
              : `The ${noun} for '${result.branch}'`;
    const title = result.title ?? result.proposal?.title;
    const url = result.proposal?.url;

    out.section(heading);
    out.variables({
        ...(result.host === undefined ? {} : { Provider: result.host }),
        Repository: result.repo,
        Branch: result.branch,
        ...(result.baseBranch === undefined ? {} : { "Target branch": result.baseBranch }),
        "Pushed to": result.dryRun ? "(nothing was pushed)" : (result.pushedTo ?? "origin"),
        "Through a fork": result.fromFork,
        ...(title === undefined ? {} : { Title: title }),
        ...(result.committedPaths === undefined || result.committedPaths.length === 0 ? {} : { Committed: result.committedPaths.join(", ") }),
        Address: url ?? (result.dryRun ? "(not opened yet)" : "(the provider printed no address)"),
    });

    return out.text();
}

/**
 * `repo contribute`: each step's own view, in order (link, submit, unlink), as today's command showed
 * each nested command's output; then, after starting one, the steps that completed (finishing one
 * reported them itself).
 */
export async function contributeView(result: ContributeResultShape, view: CliViewContext): Promise<string | undefined> {
    const parts: string[] = [];

    if (result.link !== undefined) {
        parts.push(await view.render("repo.link", result.link));
    }

    if (result.submit !== undefined) {
        parts.push(await view.render("repo.submit", result.submit));
    }

    if (result.unlink !== undefined) {
        parts.push(await view.render("repo.unlink", result.unlink));
    }

    if (result.stage === "linked" && !result.dryRun && result.completed.length > 0) {
        const out = view.printer();

        out.section("What this run did");

        for (const entry of result.completed) {
            out.paragraph(`${BULLET} ${entry}`, { indent: 4, hangingIndent: 2 });
        }

        out.footer();
        parts.push(out.text());
    }

    const text = parts.join("");

    return text === "" ? undefined : text;
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    // Every line of a release (the checks, the plan, each step, what to do next) is reported as it
    // happens; the result is for --json and for other intents.
    "repo.release": () => undefined,
    "repo.submit": submitView,
    "repo.contribute": contributeView,
    // The files written and what to do next are reported as it happens.
    "repo.init": () => undefined,
};
