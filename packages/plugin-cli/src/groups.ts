import type { CliGroupEntity } from "./types.js";

/**
 * The help of every command group today's CLI has, with the other words each one answers to: its
 * plural (`sous repos add` is `sous repo add`) and, for some, a short form (`sous ns list` is
 * `sous namespace list`). A group's alias reaches every command under it, so a command never
 * spells its group's aliases itself. The commands themselves come from the plugins that own them.
 */
export const BUILT_IN_GROUPS: readonly CliGroupEntity[] = [
    { id: "config", command: ["config"], summary: "Inspect the merged configuration", aliases: [["configs"], ["cfg"]] },
    { id: "repo", command: ["repo"], summary: "Manage the recipe repositories this project trusts", aliases: [["repos"]] },
    { id: "lock", command: ["lock"], summary: "Inspect and repair this project's lockfile", aliases: [["locks"]] },
    { id: "namespace", command: ["namespace"], summary: "Browse the namespaces the trusted repositories publish", aliases: [["namespaces"], ["ns"]] },
    { id: "recipe", command: ["recipe"], summary: "Browse the recipes the trusted repositories publish", aliases: [["recipes"], ["rc"]] },
    { id: "subscription", command: ["subscription"], summary: "Manage which recipes this project subscribes to", aliases: [["subscriptions"], ["sub"]] },
    { id: "vars", command: ["vars"], summary: "Recipe variables and their answers", aliases: [["var"]] },
    { id: "plugins", command: ["plugins"], summary: "Show and install the plugins sous loads" },
    { id: "timings", command: ["timings"], summary: "Show how long each step of this run took" },
];
