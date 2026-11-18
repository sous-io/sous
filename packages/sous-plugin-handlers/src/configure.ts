/**
 * `configure` handlers run while the config is built, inside the `handlers/configure` contributor,
 * which Sous registers on the recipes' behalf (and on behalf of plugins that add `configure`
 * handlers, though a plugin's own form is `sous.config.contribute`). Each receives the helpers and
 * the config builder:
 *
 * ```js
 * export function declareEdits(sous, { config }) {
 *     config.atPath("editor.edits").append({ file: ".claude/settings.json", ... });
 * }
 * ```
 *
 * What one adds is this contributor's patch, so it is undone when the handler stops being listed.
 */

import { messageText, type ConfigBuilder, type ContributorDefinition, type ServiceReader } from "@sous-io/plugin-api";
import { RECIPE_HANDLERS_CONTRIBUTOR } from "./recipes.js";
import { orderHandlers } from "./run.js";
import { createConfigureTools, ReportCollector } from "./tools.js";
import type { HandlerReportEntry } from "./types.js";

/** The contributor's id. */
export const CONFIGURE_CONTRIBUTOR = "handlers/configure";

/** `handlers/configure`: runs every `configure` handler in order, each with the builder. */
export function configureContributor(services: () => ServiceReader | undefined): ContributorDefinition {
    return {
        id: CONFIGURE_CONTRIBUTOR,
        after: [RECIPE_HANDLERS_CONTRIBUTOR],

        async contribute(config) {
            for (const entry of orderHandlers(config.entities("handler"), "configure", (one) => one)) {
                const collector = new ReportCollector(entry.id);
                const tools = createConfigureTools(config, services, entry.recipe, collector.report);

                try {
                    await (entry.handle as (sous: unknown, input: unknown) => unknown)(tools, { config });
                } catch (error) {
                    collector.entries.push({ level: "error", message: `The configure handler ${entry.id} failed: ${error instanceof Error ? messageText(error) : String(error)}`, handler: entry.id });
                }

                for (const report of collector.entries) {
                    forward(config, report);
                }
            }
        },
    };
}

/** Hands one report to the builder, which reports through the engine. */
function forward(config: ConfigBuilder, report: HandlerReportEntry): void {
    const details = { handler: report.handler };

    if (report.level === "error") {
        config.error(report.message, details);
    } else if (report.level === "warn") {
        config.warning(report.message, details);
    } else {
        config.info(report.message, details);
    }
}
