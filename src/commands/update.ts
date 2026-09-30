/**
 * `sous update` moves sous itself to a newer (or a chosen) version, for the
 * global install, the project's own install, or both, through whichever
 * package manager owns each one (sous-io/sous#135).
 *
 *     sous update
 *     sous update --global
 *     sous update --major
 *     sous update --version 0.2.18
 *     sous update --dry-run
 *
 * It runs outside a project as readily as inside one, so it opts out of the
 * config requirement, as `sous init` does. `bin/run.js` never hands this
 * command to a project's own copy: updating the copy that was invoked is the
 * point. The flow itself lives in `lib/self-update/run.ts`; this class turns
 * the flags into its options and decides the exit code.
 */

import path from "node:path";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { SOUS_DIR_NAME, findConfigInSousDir } from "../lib/config-discovery.js";
import { ConfigError } from "../lib/errors.js";
import { CLI_ROOT } from "../lib/package-info.js";
import { registryUrl, runSelfUpdate } from "../lib/self-update/run.js";
import type { UpdateScope, VersionRequest } from "../lib/self-update/index.js";
import { confirmationFlag } from "../utils/flags.js";
import { footer, showCommandVars } from "../utils/formatting.js";

export default class Update extends BaseCommand {
  static description =
    "Update sous itself, globally and in this project, through the package manager that installed each copy";

  /** This command updates sous wherever it is installed; a project config is optional. */
  static override requiresConfig = false;

  static examples = [
    "<%= config.bin %> update",
    "<%= config.bin %> update --global",
    "<%= config.bin %> update --major",
    "<%= config.bin %> update --version 0.2.18",
    "<%= config.bin %> update --version next",
    "<%= config.bin %> update --dry-run",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    major: Flags.boolean({
      description: "Install the newest published version, whatever its major version",
      default: false,
      exclusive: ["version"],
    }),
    version: Flags.string({
      description: "Install this version, the newest version in this range, or the version this dist-tag names",
      exclusive: ["major"],
    }),
    prerelease: Flags.boolean({
      description:
        "Count prerelease versions as candidates; on by default when the installed version is a prerelease",
      allowNo: true,
      aliases: ["pre"],
    }),
    global: Flags.boolean({
      description: "Update only the global install",
      default: false,
      exclusive: ["project"],
    }),
    project: Flags.boolean({
      description: "Update only this project's own install",
      default: false,
      exclusive: ["global"],
    }),
    yes: confirmationFlag(),
    "dry-run": Flags.boolean({
      description: "Print every install's plan without installing anything",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Update the project install without building the project afterwards",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Update);
    const dryRun = flags["dry-run"];
    const request: VersionRequest =
      flags.version !== undefined
        ? { kind: "spec", spec: flags.version }
        : flags.major
          ? { kind: "major" }
          : { kind: "default" };
    const only: UpdateScope | undefined = flags.global
      ? "global"
      : flags.project
        ? "project"
        : undefined;

    showCommandVars({
      Directory: this.configLocator.cwd,
      Installs: only === undefined ? "global and project" : `${only} only`,
      Version: describeRequest(request),
      Prereleases:
        flags.prerelease === undefined
          ? "counted when the installed version is one"
          : flags.prerelease
            ? "counted"
            : "not counted",
      Registry: registryUrl(),
      "Dry Run": dryRun,
    });

    const outcome = await runSelfUpdate({
      cwd: this.configLocator.cwd,
      ownRoot: CLI_ROOT,
      request,
      ...(flags.prerelease === undefined ? {} : { prerelease: flags.prerelease }),
      ...(only === undefined ? {} : { only }),
      dryRun,
      yes: flags.yes,
      interactive: this.interactive,
      build: !flags["no-build"],
      buildDirFor: (projectRoot) => this.buildDirFor(projectRoot),
    });

    footer();

    if (outcome.failed) {
      throw new ConfigError(
        "Not every step of the update succeeded; the summary above lists what completed and what failed."
      );
    }
  }

  /**
   * Where a build after a project update runs: the directory of the config
   * discovery found, when it lies inside the project that was updated, and
   * otherwise the project root when its own `.sous/` holds a primary config.
   * Undefined means the project has no sous config, so nothing is built.
   */
  private buildDirFor(projectRoot: string): string | undefined {
    if (this.hasConfig) {
      const configDir = path.dirname(this.discovered.sousDir);
      const relative = path.relative(projectRoot, configDir);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return configDir;
    }
    return findConfigInSousDir(path.join(projectRoot, SOUS_DIR_NAME)) === null
      ? undefined
      : projectRoot;
  }
}

/** The version request, as the opening block says it. */
function describeRequest(request: VersionRequest): string {
  if (request.kind === "default") return "the newest in each install's major version";
  if (request.kind === "major") return "the newest published, whatever its major version";
  return request.spec;
}
