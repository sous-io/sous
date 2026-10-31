/**
 * The `recipes.core` contributor: the repository and subscription every project gets without
 * asking, applied before what the project's files say, and the store seeded with the core recipe
 * the package ships.
 *
 * It applies before the user's files, and they merge after it field by field, so the shortest opt-out
 * is a complete entry:
 *
 * ```jsonc
 * { "subscriptions": { "core": { "enabled": false } } }      // keep the repository, drop the skills
 * { "repos": { "sous-recipes": { "enabled": false } } }      // drop the repository entirely
 * ```
 *
 * The `core` subscription is added only while the built-in repository is switched on.
 */

import fs from "node:fs";
import type { ContributorDefinition } from "@sous-io/plugin-api";
import { CONTRIBUTORS, CORE_NAMESPACE, OFFICIAL_REPO_NAME } from "../constants.js";
import type { PartBRuntime } from "../runtime.js";
import { messageOf } from "../support.js";
import { builtInCoreSubscription, builtInRepoEntry, packagedCoreRecipeDir } from "./core-recipe.js";
import { seedCoreRecipe, type SeedReport } from "./seed.js";
import { createSeedStamp } from "./seed-stamp.js";

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

    /**
     * The packaged manifest's `description`, read without checking the manifest: it is decoration,
     * and checking it costs more than everything else seeding does on a run that changes nothing.
     */
    private packagedDescription(dir: string): string | undefined {
        try {
            const manifests = this.runtime.services.get("formats.manifests");
            const file = manifests.find(dir, "recipe");
            const parsed = file === undefined ? undefined : (manifests.parseText(fs.readFileSync(file, "utf8"), file) as { description?: unknown } | undefined);

            return typeof parsed?.description === "string" ? parsed.description : undefined;
        } catch {
            return undefined;
        }
    }

    private async run(): Promise<SeedReport> {
        let packaged: { version: string; dir: string | undefined };

        try {
            packaged = this.packaged();
        } catch (error) {
            return { seeded: false, alreadyPresent: false, wroteIndex: false, version: "", skippedBecause: `Sous could not work out its own version, so the core recipe was not seeded. ${messageOf(error)}` };
        }

        const { dir } = packaged;
        const store = this.runtime.services.get("recipes.store");

        try {
            return await seedCoreRecipe({
                store,
                cache: this.runtime.indexCore(),
                version: packaged.version,
                packagedDir: dir,
                // Read only when a stand-in index is written or the overlay adds the version: most runs need neither.
                ...(dir === undefined ? {} : { description: () => this.packagedDescription(dir) }),
                stamp: createSeedStamp({ storeRoot: store.root, entryDir: (key) => store.entryDir(key) }),
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
                config.warn(report.skippedBecause);
            }
        },
    };
}
