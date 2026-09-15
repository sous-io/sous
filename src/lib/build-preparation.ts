/**
 * The step that runs before a project's outputs are compiled, and what it says
 * while it runs. `sous build` runs it on every build, and `sous init` runs it
 * for the first build of a project it has just set up; both must say the same
 * things about the same events, so the reporting lives here rather than in
 * either command.
 */

import type { SubscriptionService } from "./repos/subscription-service.js";
import { blankLine, footer, heading, paragraph, warning } from "../utils/formatting.js";

/**
 * Gets this project's recipes ready to compile: restores whatever the store is
 * missing (a fresh clone, or a collected store) and then asks upstream for the
 * repositories that prefer a newer in-range version.
 *
 * Restoring asks nothing and decides nothing; it fetches exactly what the
 * lockfile pins. An upstream check that fails is reported and then ignored,
 * because a build must not depend on the network being up.
 *
 * @param repositories - The subscription service for this project.
 */
export async function prepareRepositoriesForBuild(
  repositories: SubscriptionService
): Promise<void> {
  const needsRestore = repositories.needsRestore();
  if (needsRestore) {
    heading("Restoring recipes");
    blankLine();
    paragraph(
      "This project's lockfile pins recipes that are not in the store on this " +
        "machine, so they are being fetched at exactly the versions it records."
    );
  }

  const { seed, subscriptions, restored, upstream } =
    await repositories.prepareForBuild();

  // Seeding the packaged core recipe is silent when it works, which is almost
  // always; it is only worth a word when it could not be done at all.
  if (seed.skippedBecause !== undefined) warning(seed.skippedBecause);

  // A subscription the lockfile did not pin yet has just been pinned. That is
  // a change to a committed file, so it is always announced.
  if (subscriptions.added.length > 0 || subscriptions.moved.length > 0) {
    heading("Locking subscribed recipes");
    blankLine();
    for (const entry of subscriptions.added) {
      paragraph(`  pinned: ${entry.key} at version ${entry.version}.`);
    }
    for (const change of subscriptions.moved) {
      paragraph(`  ${change.key} moved from version ${change.from} to version ${change.to}.`);
    }
    blankLine();
    paragraph(
      "The lockfile has been updated. Commit it, so everyone building this project " +
        "gets exactly these versions."
    );
    footer();
  }

  for (const failure of subscriptions.failed) {
    warning(
      `Sous could not work out which version of '${failure.key}' to use, so nothing ` +
        `from it was compiled.\n${failure.reason}`
    );
  }

  if (restored !== undefined && restored.restored.length > 0) {
    blankLine();
    for (const key of restored.restored) paragraph(`  restored: ${key}`);
  }

  for (const change of upstream.updated) {
    paragraph(`  ${change.key} moved from ${change.from} to ${change.to}.`);
  }

  for (const failure of upstream.failed) {
    warning(
      `Sous could not check the repository '${failure.repo}' for a newer version, so ` +
        `this build uses the versions it already had.\n${failure.reason}`
    );
  }

  if (needsRestore) footer();
}
