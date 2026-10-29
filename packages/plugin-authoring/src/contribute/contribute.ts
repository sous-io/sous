/**
 * `repo.contribute`: starts a contribution to a recipe repository in one go, and `--finish` ends it.
 * It chains the intents that already exist and adds nothing they lack:
 *
 *   - Start runs `repo.link <repo> --latest` on a new branch.
 *   - Finish looks at what the branch holds that no proposal carries yet, asks whether to submit it
 *     (`repo.submit`), then runs `repo.unlink <repo> --update`.
 *
 * Each step runs in the same chain (`ctx.run`), so it behaves as it does on its own; a failure lists
 * the steps that had completed. The ref may name a repository, or a namespace or recipe, in which case
 * the repository that publishes it is used.
 */

import { ConfigError, type Context, type IntentInput, type IntentResult } from "@sous-io/plugin-api";
import type { SousRef } from "@sous-io/plugin-refs/types";
import type { RepoContributeInput, RepoContributeResult } from "../types.js";
import { toolsFrom, type AuthoringTools } from "../tools.js";
import { RepoGit } from "../shared/git.js";
import { describeError } from "../shared/problems.js";
import { assessPendingWork, assessStatusResult, pendingWork, type PendingVerdict } from "./pending.js";

/** The intents a contribution is made of. */
type StepIntent = "repo.link" | "repo.submit" | "repo.unlink";

/** One intent a contribution runs, and how to talk about it. */
export interface ContributionStep<N extends StepIntent = StepIntent> {
    readonly intent: N;
    readonly input: IntentInput<N>;
    /** What it does, as a heading printed when it starts. */
    readonly running: string;
    /** What it did, as a line in the completed list. */
    readonly done: string;
}

/** Runs an intent in the chain; `ctx.run` in production. */
export type IntentRunner = <N extends StepIntent>(intent: N, input: IntentInput<N>) => Promise<IntentResult<N>>;

/** The intent's handler. */
export async function handleContribute(input: RepoContributeInput, ctx: Context): Promise<RepoContributeResult> {
    return runContribute(toolsFrom(ctx), input, (intent, stepInput) => ctx.run(intent, stepInput));
}

/** Starts or finishes a contribution. */
export async function runContribute(tools: AuthoringTools, input: RepoContributeInput, run: IntentRunner): Promise<RepoContributeResult> {
    const finishing = input.finish === true;
    const dryRun = input.dryRun === true;

    assertFlagsAgree(input);
    tools.reporter.log("info", `Reference: ${input.ref}`);
    tools.reporter.log("info", `Mode: ${finishing ? "Finish a contribution" : "Start a contribution"}`);
    tools.reporter.log("info", `Scope: ${input.global === true ? "this machine" : "this project"}`);

    const repo = await resolveRepository(tools, input.ref, input.acceptFirst === true);

    return finishing ? finish(tools, repo, input, run, dryRun) : start(tools, repo, input, run, dryRun);
}

/** The step that starts a contribution: `repo link <repo> --latest` on a new branch. */
export function startStep(repo: string, input: RepoContributeInput): ContributionStep<"repo.link"> {
    const base = {
        repo,
        latest: true,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.global === true ? { global: true } : {}),
        ...(input.yes === true ? { yes: true } : {}),
    };

    if (input.branch !== undefined) {
        return {
            intent: "repo.link",
            input: { ...base, branch: input.branch },
            running: `Linking '${repo}' on the branch '${input.branch}', made to match upstream's`,
            done: `Linked '${repo}' on the branch '${input.branch}'`,
        };
    }

    if (input.createBranch !== undefined) {
        return {
            intent: "repo.link",
            input: { ...base, createBranch: input.createBranch },
            running: `Linking '${repo}' on a new branch named '${input.createBranch}'`,
            done: `Linked '${repo}' on the new branch '${input.createBranch}'`,
        };
    }

    return {
        intent: "repo.link",
        input: { ...base, generateBranch: true },
        running: `Linking '${repo}' on a new branch with a generated name`,
        done: `Linked '${repo}' on a new branch`,
    };
}

/** The step that proposes what the branch holds. `--yes` passes on only when given. */
export function submitStep(repo: string, input: RepoContributeInput): ContributionStep<"repo.submit"> {
    return {
        intent: "repo.submit",
        input: {
            repo,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(input.draft === true ? { draft: true } : {}),
            ...(input.commit === true ? { commit: true } : {}),
            ...(input.yes === true ? { yes: true } : {}),
        },
        running: "Proposing what the branch holds",
        done: "Proposed what the branch holds",
    };
}

/** The step that ends a contribution: `repo unlink <repo> --update`, back to the published versions. */
export function unlinkStep(repo: string, input: RepoContributeInput): ContributionStep<"repo.unlink"> {
    const remove = input.remove === true;

    return {
        intent: "repo.unlink",
        input: {
            repo,
            update: true,
            ...(remove ? { remove: true } : {}),
            ...(input.global === true ? { global: true } : {}),
            ...(input.yes === true ? { yes: true } : {}),
        },
        running: remove ? `Unlinking '${repo}', updating its pins and deleting the checkout` : `Unlinking '${repo}' and updating its pins`,
        done: remove ? `Unlinked '${repo}', updated its pins and deleted the checkout` : `Unlinked '${repo}' and updated its pins`,
    };
}

/**
 * A step as the command line that runs it, for a dry run and for running the parts by hand.
 *
 * ```ts
 * commandLine(startStep("sous-recipes", { ref: "sous-recipes" }));
 * // "sous repo link sous-recipes --latest --generate-branch"
 * ```
 */
export function commandLine(step: ContributionStep): string {
    const input = step.input as unknown as Record<string, unknown>;
    const words = ["sous", ...step.intent.split("."), String(input.repo)];

    for (const [field, value] of Object.entries(input)) {
        if (field === "repo" || value === undefined || value === false) {
            continue;
        }

        const flag = `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

        words.push(...(value === true ? [flag] : [flag, String(value)]));
    }

    return words.map(quoteArgument).join(" ");
}

function quoteArgument(value: string): string {
    return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function start(tools: AuthoringTools, repo: string, input: RepoContributeInput, run: IntentRunner, dryRun: boolean): Promise<RepoContributeResult> {
    const step = startStep(repo, input);
    const steps = [commandLine(step)];

    tools.reporter.log("info", `Starting a contribution\n  This runs one step:\n    ${steps[0]}`);

    if (dryRun) {
        tools.reporter.note("Dry run: no step was run.");

        return { stage: "linked", repo, steps, completed: [], dryRun: true };
    }

    const completed: string[] = [];
    const link = await runStep(tools, step, completed, run);
    const branch = link.branch ?? (await new RepoGit(tools.git, link.path).currentBranch().catch(() => undefined));

    tools.reporter.log(
        "info",
        `Repository: ${repo}\nCheckout: ${link.path}${branch === undefined ? "" : `\nBranch: ${branch}`}\n` +
            `Builds read '${repo}' from this checkout until the contribution is finished, so an edit made there shows up in ` +
            `this project's next build.`,
        { link },
    );

    return { stage: "linked", repo, steps, completed, link, dryRun: false };
}

async function finish(tools: AuthoringTools, repo: string, input: RepoContributeInput, run: IntentRunner, dryRun: boolean): Promise<RepoContributeResult> {
    const linkPath = requireLink(tools, repo, input.global === true);
    const completed: string[] = [];

    tools.reporter.log("info", `Finishing a contribution\n  Repository: ${repo}\n  Checkout: ${linkPath}`);
    tools.reporter.log("info", "Looking for work no proposal carries yet");

    const work = await pendingWork(new RepoGit(tools.git, linkPath), input.branch);
    const base = work.baseBranch === undefined ? "upstream" : `origin/${work.baseBranch}`;

    tools.reporter.log(
        "info",
        [
            `  Branch: ${work.branch ?? "(none; HEAD is detached)"}`,
            `  Uncommitted changes: ${work.uncommitted.length}`,
            `  Commits ${base} lacks: ${work.ahead.length}`,
            `  Commits not pushed: ${work.unpushed.length}`,
            `  Pushed to: ${work.pushedCopies.length === 0 ? "nowhere yet" : work.pushedCopies.join(", ")}`,
        ].join("\n"),
        { work },
    );

    let verdict = assessPendingWork(work);

    if (verdict.kind === "lookup" && !dryRun) {
        tools.reporter.log("info", verdict.reason);
        verdict = await lookUpProposal(repo, work.branch!, run);
    }

    tools.reporter.log("info", verdict.reason);
    completed.push("Looked for work no proposal carries yet");

    const unlink = unlinkStep(repo, input);
    const submit = submitStep(repo, input);

    if (dryRun) {
        if (verdict.kind === "nothing") {
            tools.reporter.note("Dry run: would skip submitting, since there is nothing to submit.");
        } else {
            if (verdict.kind === "lookup") {
                tools.reporter.note("Dry run: would look the branch's proposal up, and treat the branch as having work to submit when none is open.");
            }

            tools.reporter.note(`Dry run: ${describeSubmitDecision(input)}.`);
        }

        const planned = verdict.kind === "nothing" || input.submit === false ? [unlink] : [submit, unlink];
        const steps = planned.map(commandLine);

        tools.reporter.log("info", `${describeSteps(steps)}\nDry run: no step was run.`);

        return { stage: "finished", repo, steps, completed, verdict: verdict.reason, dryRun: true };
    }

    const submitting = verdict.kind !== "nothing" && (await shouldSubmit(tools, input));

    if (verdict.kind !== "nothing" && !submitting) {
        tools.reporter.log("info", "It is not submitted; the checkout keeps it.");
    }

    const steps = submitting ? [commandLine(submit), commandLine(unlink)] : [commandLine(unlink)];

    tools.reporter.log("info", describeSteps(steps));

    const submitted = submitting ? await runStep(tools, submit, completed, run) : undefined;
    const unlinked = await runStep(tools, unlink, completed, run);

    tools.reporter.log("info", `What this run did:\n${completed.map((entry) => `  - ${entry}`).join("\n")}`);

    return {
        stage: "finished",
        repo,
        steps,
        completed,
        verdict: verdict.reason,
        ...(submitted === undefined ? {} : { submit: submitted }),
        unlink: unlinked,
        dryRun: false,
    };
}

/** Flags that mean nothing together; the old command line refused them while parsing. */
function assertFlagsAgree(input: RepoContributeInput): void {
    const named = [input.branch !== undefined && "--branch", input.createBranch !== undefined && "--create-branch", input.generateBranch === true && "--generate-branch"].filter(
        (flag): flag is string => flag !== false,
    );

    if (named.length > 1) {
        throw new ConfigError(`${named.join(" and ")} cannot be used together: each names the branch a different way.`);
    }

    if (input.finish === true) {
        const startOnly = [input.createBranch !== undefined && "--create-branch", input.generateBranch === true && "--generate-branch", input.from !== undefined && "--from"].filter(
            (flag): flag is string => flag !== false,
        );

        if (startOnly.length > 0) {
            throw new ConfigError(`${startOnly.join(" and ")} only ${startOnly.length === 1 ? "starts" : "start"} a contribution, so cannot be used with --finish.`);
        }

        return;
    }

    if (input.from !== undefined && input.branch !== undefined) {
        throw new ConfigError("--from starts a new branch, so it cannot be used with --branch, which names an existing one.");
    }

    const finishOnly = [
        input.submit !== undefined && "--submit",
        input.title !== undefined && "--title",
        input.body !== undefined && "--body",
        input.draft === true && "--draft",
        input.commit === true && "--commit",
        input.remove === true && "--remove",
    ].filter((flag): flag is string => flag !== false);

    if (finishOnly.length > 0) {
        throw new ConfigError(`${finishOnly.join(", ")} ${finishOnly.length === 1 ? "only applies" : "only apply"} when finishing; pass --finish as well.`);
    }
}

/** The repository a ref names: the repository itself, or the one publishing a namespace or recipe. */
async function resolveRepository(tools: AuthoringTools, ref: string, acceptFirst: boolean): Promise<string> {
    const { refs } = await tools.refs.resolve({ input: ref, kinds: ["repo", "namespace", "recipe"], refusedIsEmpty: true });
    const picker = tools.picker();
    const details = ["  No trusted repository, namespace or recipe has that name."];
    let chosen: SousRef | undefined;

    if (picker !== undefined) {
        chosen = await picker.pick(
            refs,
            { search: ref, acceptFirst, prompt: `Which '${ref}' do you want to contribute to?`, details },
            { prompter: tools.prompter, reporter: tools.reporter },
        );
    } else {
        chosen = refs[0];
    }

    const name = chosen === undefined ? undefined : chosen.kind === "repo" ? chosen.name : tools.format.partsOf(chosen).repo?.name;

    if (name === undefined) {
        throw new ConfigError(`'${ref}' names no repository this project trusts, and no namespace or recipe one publishes.\n${details.join("\n")}`);
    }

    return name;
}

/** The checkout a contribution being finished runs on, or an error naming where it is linked instead. */
function requireLink(tools: AuthoringTools, repo: string, isGlobal: boolean): string {
    const links = tools.links();

    if (links === undefined) {
        throw new ConfigError(`'${repo}' cannot be finished outside a sous project: links are kept by a project.`);
    }

    const scope = isGlobal ? "global" : "project";
    const link = links.get(repo);

    if (link !== undefined && link.scope === scope) {
        return link.path;
    }

    const searched = isGlobal ? "the machine-wide links map" : "this project's links map";

    throw new ConfigError(
        `'${repo}' is not linked in ${searched}, so there is no contribution to finish.\n` +
            (link === undefined
                ? "  Nothing was changed."
                : `  It is linked in the ${isGlobal ? "project" : "machine-wide"} map, at ${link.path}; run the same command ` +
                  `${isGlobal ? "without" : "with"} --global to finish that one.`),
    );
}

/** Looks the proposal up; a failed lookup counts as work to submit, with the reason. */
async function lookUpProposal(repo: string, branch: string, run: IntentRunner): Promise<PendingVerdict> {
    try {
        return assessStatusResult(branch, await run("repo.submit", { repo, branch, status: true }));
    } catch (error) {
        const reason = describeError(error).split("\n")[0]!.trim();

        return {
            kind: "pending",
            reason: `Every commit on the branch '${branch}' was pushed, but sous could not look its proposal up, so it cannot tell whether one is open. ${reason}`,
        };
    }
}

/** `--no-submit` says no, `--submit` or `--yes` say yes, otherwise the person is asked. */
async function shouldSubmit(tools: AuthoringTools, input: RepoContributeInput): Promise<boolean> {
    if (input.submit !== undefined) {
        return input.submit;
    }

    if (input.yes === true) {
        return true;
    }

    return tools.prompter.confirm({
        message: "Submit it before finishing?",
        answeredBy: "--submit (or --yes) to submit it, or --no-submit to finish without submitting it",
        default: true,
    });
}

function describeSubmitDecision(input: RepoContributeInput): string {
    if (input.submit === false) {
        return "would not submit it, because --no-submit was passed";
    }

    if (input.submit === true) {
        return "would submit it without asking, because --submit was passed";
    }

    return input.yes === true ? "would submit it without asking, because --yes was passed" : "would ask whether to submit it";
}

function describeSteps(steps: readonly string[]): string {
    return `${steps.length === 1 ? "This runs one step:" : `This runs ${steps.length} steps:`}\n${steps.map((step) => `  - ${step}`).join("\n")}`;
}

/** Runs one step in the chain; a failure says which steps had completed. */
async function runStep<N extends StepIntent>(tools: AuthoringTools, step: ContributionStep<N>, completed: string[], run: IntentRunner): Promise<IntentResult<N>> {
    tools.reporter.log("info", `${step.running}\n  ${commandLine(step)}`);

    try {
        const result = await run(step.intent, step.input);

        completed.push(step.done);

        return result;
    } catch (error) {
        throw new ConfigError(
            `${step.running}: this step failed.\n\n  ${describeError(error)}\n\n  What had already been done:\n` +
                (completed.length === 0 ? "    nothing" : completed.map((entry) => `    ${entry}`).join("\n")),
            { cause: error },
        );
    }
}
