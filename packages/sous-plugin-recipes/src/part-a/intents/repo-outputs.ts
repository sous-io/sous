/**
 * The outputs of `repo.add`, `repo.remove` and `repo.trust`.
 *
 * The handlers already report their plans and notes as they work (the trust ceremony, "The recipe
 * 'x' stays, because ...", "Linked 'x' to ..."), so these outputs hold the outcome: the blocks a
 * command shows after its work was done.
 */

import type { Context, TableColumn } from "@sous-io/plugin-api";
import type { RepoAddResult, RepoRemoveResult, RepoTrustResult } from "../../types.js";
import {
    blockOutput,
    dryRunOutput,
    finishWithFollowUps,
    finish,
    lockfileOutput,
    listOutput,
    noteOutput,
    rebuilt,
    sentence,
    tableOutput,
    underHeading,
} from "../outputs.js";

const STAYED_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "heldBy", header: "Still held by", overflow: "wrap", flex: 1, minWidth: 16 },
];

/** The outputs of `repo.add`. */
export function repoAddOutputs(result: RepoAddResult) {
    const heading = "Adding a repository";

    if (result.dryRun) {
        return finish(
            [
                dryRunOutput("Nothing will be trusted, written or downloaded.", heading),
                noteOutput(`The repository would be added as '${result.name}', read through the ${result.provider} provider, and its index would be fetched.`),
            ],
            result,
        );
    }

    return finish(
        [
            blockOutput(
                {
                    Repository: result.name,
                    Location: result.url,
                    Provider: result.provider,
                    Namespaces: result.namespaces.length > 0 ? result.namespaces.join(", ") : "none; this repository publishes nothing yet",
                    Recipes: String(result.recipeCount),
                },
                { heading },
            ),
            noteOutput(
                result.alreadyTrusted
                    ? `This project already trusted '${result.name}', so only its index was refreshed.`
                    : `This project now trusts '${result.name}'. Nothing from it has been installed.`,
            ),
        ],
        result,
    );
}

/** The outputs of `repo.remove`. */
export function repoRemoveOutputs(ctx: Pick<Context, "reporter">, result: RepoRemoveResult) {
    const pruneHint = rebuilt(result) ? "" : " Run 'sous build' to prune what it used to write.";
    const outputs = [];

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing will be written."));
    }

    // The plan, unless the handler reported it already before asking.
    const [first, ...rest] = result.plan ?? [];

    if (first !== undefined) {
        outputs.push(sentence(first));

        if (rest.length > 0) {
            outputs.push(listOutput(rest, { listTitle: "Here is what goes with it:" }));
        }
    }

    outputs.push(lockfileOutput(result.diff, "Nothing changed; nothing was locked because of this repository."));

    if (result.stayed.length > 0) {
        outputs.push(
            tableOutput(
                STAYED_COLUMNS,
                result.stayed.map((entry) => ({ key: entry.key, heldBy: entry.heldBy.join(", ") })),
                { tableTitle: "What stayed, and why" },
            ),
        );
    }

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing was written. Run the same command without '--dry-run' to remove it."));
    } else {
        outputs.push(
            sentence(
                result.optedOut
                    ? `The repository '${result.name}' is one sous provides itself, so it was switched off rather than deleted: this project's config now records '${result.name}: { enabled: false }'.${pruneHint}`
                    : `This project no longer trusts '${result.name}'. Nothing is read from it any more, and its entry is gone from the repositories layer.${pruneHint}`,
            ),
        );
    }

    return finishWithFollowUps(
        ctx,
        underHeading("Removing a repository", outputs),
        result,
        `The repository '${result.name}' was removed, but the build that followed it failed, so this project may still hold files its recipes used to write. The removal itself is recorded and locked; fix what the build reported above and run 'sous build' again.`,
    );
}

/** The outputs of `repo.trust`. */
export function repoTrustOutputs(result: RepoTrustResult) {
    const outputs = [];

    if (result.dryRun) {
        outputs.push(dryRunOutput("Nothing will be written."));
    }

    outputs.push(blockOutput({ Repository: result.name, Location: result.url }));

    if (result.alreadyTrusted) {
        outputs.push(noteOutput(`This project already trusts '${result.name}'; nothing changed.`));
    } else if (result.dryRun) {
        outputs.push(dryRunOutput(`Nothing was written. Run the same command without '--dry-run' to trust '${result.name}'.`));
    } else {
        outputs.push(noteOutput(result.trusted ? `This project now trusts '${result.name}'. Nothing from it has been installed.` : `'${result.name}' was not trusted; nothing changed.`));
    }

    return finish(underHeading("Trusting a repository", outputs), result);
}
