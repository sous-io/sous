import { isSousError } from "@sous-io/plugin-api";
import type { CliViewEntity } from "../types.js";
import { renderResult } from "./show.js";

/** A domain module of views: one render function per intent it shows. */
export interface ViewModule {
    readonly views: Readonly<Record<string, CliViewEntity["render"]>>;
}

/**
 * Which module shows which intents. Modules load only when one of their intents has a result to
 * show, so `--help` never imports view code (G9).
 */
const DOMAINS: ReadonlyArray<{ load: () => Promise<ViewModule>; intents: readonly string[] }> = [
    { load: () => import("./domains/vars.js"), intents: ["vars.ask", "vars.list", "vars.show", "vars.map"] },
    {
        load: () => import("./domains/catalog.js"),
        intents: ["namespace.list", "namespace.show", "recipe.list", "recipe.show", "repo.search", "repo.list"],
    },
    { load: () => import("./domains/updates.js"), intents: ["recipe.update", "subscription.update", "lock.rebuild", "lock.show"] },
    {
        load: () => import("./domains/repos.js"),
        intents: [
            "repo.add",
            "repo.remove",
            "repo.trust",
            "repo.gc",
            "repo.link",
            "repo.unlink",
            "subscription.add",
            "subscription.remove",
            "subscription.enable",
            "subscription.disable",
            "subscription.list",
        ],
    },
    { load: () => import("./domains/build.js"), intents: ["build", "compile", "build.prepare", "prune", "clear", "build.watch", "launch"] },
    { load: () => import("./domains/setup.js"), intents: ["init", "update", "plugins.install"] },
    { load: () => import("./domains/inspect.js"), intents: ["config.show", "config.get", "config.validate", "plugins.show", "timings.show", "version"] },
    { load: () => import("./domains/authoring.js"), intents: ["repo.release", "repo.submit", "repo.contribute", "repo.init"] },
];

/** Intents whose built-in view shows a plain text result too. */
const TEXT_RESULTS = new Set(["version"]);

/**
 * The views plugin-cli adds, one `cli-view` entity per intent it knows how to show. A result that is
 * not the shape a view expects (a plugin replaced the intent with its own) prints as it would with
 * no view: text as it is, anything else as JSON. A view's own `SousError` (a `config get` of a
 * missing path) still fails the command.
 */
export const BUILT_IN_VIEWS: readonly CliViewEntity[] = DOMAINS.flatMap(({ load, intents }) =>
    intents.map(
        (intent): CliViewEntity => ({
            id: intent,
            render: async (result, view) => {
                if ((typeof result !== "object" || result === null) && !TEXT_RESULTS.has(intent)) {
                    return renderResult(result);
                }

                const render = (await load()).views[intent];

                if (!render) {
                    return renderResult(result);
                }

                try {
                    return await render(result, view);
                } catch (error) {
                    if (isSousError(error)) {
                        throw error;
                    }

                    return renderResult(result);
                }
            },
        }),
    ),
);
