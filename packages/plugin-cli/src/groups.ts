import type { CliGroupEntity } from "./types.js";

/**
 * The help of every command group today's CLI has, with the plural word each one also answers to
 * (`sous repos add` is `sous repo add`). The commands themselves come from the plugins that own them.
 */
export const BUILT_IN_GROUPS: readonly CliGroupEntity[] = [
    { id: "config", command: ["config"], summary: "Inspect the merged configuration", aliases: [["configs"]] },
    { id: "repo", command: ["repo"], summary: "Manage the recipe repositories this project trusts", aliases: [["repos"]] },
    { id: "lock", command: ["lock"], summary: "Inspect and repair this project's lockfile", aliases: [["locks"]] },
    { id: "namespace", command: ["namespace"], summary: "Browse the namespaces the trusted repositories publish", aliases: [["namespaces"]] },
    { id: "recipe", command: ["recipe"], summary: "Browse the recipes the trusted repositories publish", aliases: [["recipes"]] },
    { id: "subscription", command: ["subscription"], summary: "Manage which recipes this project subscribes to", aliases: [["subscriptions"]] },
    { id: "vars", command: ["vars"], summary: "Recipe variables and their answers", aliases: [["var"]] },
];
