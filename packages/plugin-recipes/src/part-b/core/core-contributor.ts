/**
 * The `recipes.core` contributor: the repository and subscription every project gets without
 * asking, added underneath what the project's files say, and the store seeded with the core recipe
 * the package ships.
 *
 * It runs before the user's files, and they merge on top field by field, so the shortest opt-out
 * is a complete entry:
 *
 * ```jsonc
 * { "subscriptions": { "core": { "enabled": false } } }      // keep the repository, drop the skills
 * { "repos": { "sous-recipes": { "enabled": false } } }      // drop the repository entirely
 * ```
 *
 * The `core` subscription is added only while the built-in repository is switched on.
 */

import type { ContributorDefinition } from "@sous-io/plugin-api";
import { CONTRIBUTORS, CORE_NAMESPACE, OFFICIAL_REPO_NAME } from "../constants.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf } from "../support.js";
import { builtInCoreSubscription, builtInRepoEntry, packagedCoreRecipeDir } from "./core-recipe.js";
import { seedCoreRecipe, type SeedReport } from "./seed.js";

/** Seeds once per process; later passes and builds reuse the answer. */
export class CoreSeeder {
    private seeding: Promise<SeedReport> | undefined;

    constructor(private readonly runtime: PartBRuntime) {}

    /** The running sous version and the packaged recipe's directory. */
    packaged(): { version: string; dir: string | undefined } {
        const identity = this.runtime.services.get("host.package").identity();

        return { version: identity.version, dir: packagedCoreRecipeDir(identity.root) };
    }

    /** Seeds the store, once. Never throws. */
    seed(): Promise<SeedReport> {
        this.seeding ??= this.run();

        return this.seeding;
    }

    private async run(): Promise<SeedReport> {
        let packaged: { version: string; dir: string | undefined };

        try {
            packaged = this.packaged();
        } catch (error) {
            return { seeded: false, alreadyPresent: false, wroteIndex: false, version: "", skippedBecause: `Sous could not work out its own version, so the core recipe was not seeded. ${messageOf(error)}` };
        }

        let description: string | undefined;

        try {
            description = packaged.dir === undefined ? undefined : (await this.runtime.services.get("formats.manifests").readRecipe(packaged.dir))?.manifest.description;
        } catch {
            description = undefined;
        }

        try {
            return await seedCoreRecipe({
                store: this.runtime.services.get("recipes.store"),
                cache: this.runtime.indexCore(),
                version: packaged.version,
                packagedDir: packaged.dir,
                ...(description === undefined ? {} : { description }),
                onMismatch: (published, local) =>
                    this.runtime.host.reporter.warning(
                        `The repository '${OFFICIAL_REPO_NAME}' publishes version ${packaged.version} of the core recipe with different contents from the copy inside this installation, so sous uses the published one. Published: ${published}. Packaged: ${local}. Reinstalling sous brings the two back into line.`,
                    ),
            });
        } catch (error) {
            return { seeded: false, alreadyPresent: false, wroteIndex: false, version: packaged.version, skippedBecause: messageOf(error) };
        }
    }
}

/** The `recipes.core` contributor. */
export function coreContributor(runtime: PartBRuntime, seeder: CoreSeeder): ContributorDefinition {
    return {
        id: CONTRIBUTORS.core,
        before: ["@sous-io/plugin-config-files", "config-files.*", "confd/*"],

        async contribute(config) {
            let version: string;

            try {
                version = seeder.packaged().version;
            } catch {
                return;
            }

            config.atPath(["repos", OFFICIAL_REPO_NAME]).merge(builtInRepoEntry());

            if (config.atPath(["repos", OFFICIAL_REPO_NAME, "enabled"]).get() !== false) {
                config.atPath(["subscriptions", CORE_NAMESPACE]).merge(builtInCoreSubscription(version));
            }

            const report = await seeder.seed();

            if (report.skippedBecause !== undefined) {
                config.log("warning", report.skippedBecause);
            }
        },
    };
}
