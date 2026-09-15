/**
 * `sous init` sets a project up for sous.
 *
 * It writes the `.sous/` directory a project needs (a commented primary config,
 * the starter prompt that config compiles, the two answers files and the
 * sous-managed ignore block) and then runs the first build, which is what
 * seeds the `core` recipe and pins it in the lockfile. A project that is
 * already set up is left exactly as it is.
 *
 * This is the one command that runs BEFORE a project config exists, so it
 * opts out of the config requirement every other command inherits. Discovery
 * still runs, which is how `--sous-dir` and `SOUS_DIR` say where to write, and
 * how a run inside an existing project is noticed.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import { BaseCommand } from "../base-command.js";
import { prepareRepositoriesForBuild } from "../lib/build-preparation.js";
import { buildProjectOutputs } from "../lib/build-service.js";
import {
  CONFIG_FILE_NAMES,
  SOUS_DIR_NAME,
  discoverConfig,
  expandHome,
  resolveConfigFlag,
} from "../lib/config-discovery.js";
import { ConfigError } from "../lib/errors.js";
import { nonInteractiveError } from "../lib/interactive.js";
import { subscriptionServiceFor } from "../lib/repos/subscription-service.js";
import {
  PROJECT_CONFIG_FORMATS,
  STARTER_OUTPUT_NAME,
  STARTER_PROMPT_RELATIVE_PATH,
  scaffoldProject,
  sousDirFor,
  type ProjectConfigFormat,
} from "../lib/project-scaffold/index.js";
import { SOUS_VERSION } from "../lib/settings.js";
import { confirmationFlag } from "../utils/flags.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  log,
  paragraph,
  section,
  showCommandVars,
  showVariables,
  warning,
} from "../utils/formatting.js";

export default class Init extends BaseCommand {
  static description =
    "Set a project up for sous: write its .sous/ directory, then run the first build";

  /** This command creates the config; finding none is its normal case. */
  static override requiresConfig = false;

  static examples = [
    "<%= config.bin %> init",
    "<%= config.bin %> init ./my-project",
    "<%= config.bin %> init --format json",
    "<%= config.bin %> init --name 'My Project' --no-build",
    "<%= config.bin %> init --dry-run",
  ];

  static args = {
    directory: Args.string({
      description: "Project directory to set up (defaults to the current one)",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    format: Flags.string({
      description: "Format of the primary config to write",
      options: [...PROJECT_CONFIG_FORMATS],
      default: PROJECT_CONFIG_FORMATS[0],
    }),
    name: Flags.string({
      description: "Display name for the project (defaults to the directory's own name)",
    }),
    // The one question this command can ask: whether to set up a project
    // inside another one.
    yes: confirmationFlag(),
    "dry-run": Flags.boolean({
      description: "Print the files that would be written without writing them",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Write the setup without running the first build",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);
    const dryRun = flags["dry-run"];
    const format = flags.format as ProjectConfigFormat;

    const sousDir = this.targetSousDir(args.directory);
    const projectRoot = path.dirname(sousDir);

    showCommandVars({
      Directory: projectRoot,
      Config: path.join(sousDir, `sous.config.${format}`),
      Name: flags.name ?? "(from the directory name)",
      "Dry Run": dryRun,
      Build: !dryRun && !flags["no-build"],
    });

    await this.confirmNesting(projectRoot, flags.yes);

    section("Setting up the project");

    const result = await scaffoldProject({
      sousDir,
      format,
      name: flags.name,
      dryRun,
      sousVersion: SOUS_VERSION,
    });

    for (const file of result.files) {
      if (result.dryRun) dryRunNotice(`would write ${file}`);
      else log(`  wrote ${file}`);
    }

    if (result.dryRun) {
      blankLine();
      dryRunNotice("Nothing was written. Run the same command without '--dry-run' to set the project up.");
      footer();
      return;
    }

    if (!flags["no-build"]) {
      await this.buildProject(result.configPath);
    }

    section("What was set up");
    showVariables([
      { label: "Config", value: result.configPath },
      { label: "Prompt source", value: path.join(sousDir, STARTER_PROMPT_RELATIVE_PATH) },
      { label: "Compiled to", value: path.join(projectRoot, STARTER_OUTPUT_NAME) },
      { label: "Skills", value: path.join(projectRoot, ".claude", "skills") },
      { label: "Shared answers", value: path.join(sousDir, ".env"), detail: "committed" },
      {
        label: "Local answers",
        value: path.join(sousDir, ".env.local"),
        detail: "gitignored; .env.local.example shows the layout",
      },
    ]);

    blankLine();
    paragraph(
      `  ${STARTER_OUTPUT_NAME} and the skills directory are build output, compiled from the ` +
        `prompt source and from the recipes this project subscribes to; a build recompiles ` +
        `them. The config explains each of its blocks in its own comments.`
    );

    footer();
  }

  /**
   * Where the `.sous/` directory goes. A directory argument wins; otherwise the
   * config-locating flags say where the project is, and otherwise it is the
   * working directory. A path that already names a `.sous/` directory, or a
   * config file inside one, is honored as such.
   */
  private targetSousDir(directory: string | undefined): string {
    if (directory !== undefined) {
      return sousDirFor(path.resolve(this.configLocator.cwd, expandHome(directory)));
    }

    const primary = this.configLocator.primary;
    if (primary === undefined) return sousDirFor(this.configLocator.cwd);

    const value = primary.value;
    if (path.basename(value) === SOUS_DIR_NAME) return value;
    if ((CONFIG_FILE_NAMES as readonly string[]).includes(path.basename(value))) {
      return path.dirname(value);
    }
    return sousDirFor(value);
  }

  /**
   * A project set up inside another one is a real choice, not a mistake sous
   * should prevent: a subproject may want its own instructions. So when a walk
   * up from the target finds a config in a parent directory, the facts are
   * stated and the question is asked once; `--yes` answers it ahead of time,
   * and a run with no terminal fails naming that flag.
   *
   * The target's own `.sous/` holding a config is a different case, refused
   * outright by the scaffold.
   */
  private async confirmNesting(projectRoot: string, confirmed: boolean): Promise<void> {
    const enclosing = discoverConfig(projectRoot);
    if (enclosing === null || path.dirname(enclosing.sousDir) === projectRoot) return;

    const enclosingRoot = path.dirname(enclosing.sousDir);

    warning(
      `${projectRoot} is inside a project that is already set up for sous.\n` +
        `  The enclosing project's config is ${enclosing.configPath}.\n` +
        `  Setting this directory up too gives it a config of its own: commands run ` +
        `here will find this one, and commands run from ${enclosingRoot} will keep ` +
        `finding the other.`
    );

    if (confirmed) return;

    if (!this.interactive) {
      throw nonInteractiveError({
        prompt: `whether to set up ${projectRoot} inside the project at ${enclosingRoot}`,
        remedy: "pass --yes (also -y, --force) to set it up anyway",
      });
    }

    blankLine();
    const proceed = await confirm({
      message: `Set up ${projectRoot} as a project of its own?`,
      default: false,
    });
    if (!proceed) {
      throw new ConfigError(
        `Nothing was written. Run 'sous init' from a directory outside ${enclosingRoot}, ` +
          `or pass --yes to set this one up anyway.`
      );
    }
  }

  /**
   * Adopts the config just written and builds the project with it, in the
   * same two steps `sous build` takes: the repositories are prepared (which
   * seeds the core recipe into the store and pins it in the lockfile), then
   * the outputs are compiled.
   *
   * @param configPath - The primary config the scaffold wrote.
   */
  private async buildProject(configPath: string): Promise<void> {
    await this.adoptConfig(
      resolveConfigFlag(configPath, this.configLocator.cwd, this.configLocator.confDirOverride)
    );

    await prepareRepositoriesForBuild(
      subscriptionServiceFor({
        configContext: this.configContext,
        settings: this.settings,
        shellEnv: this.shellEnv,
      })
    );

    heading("Building the project");

    const succeeded = await buildProjectOutputs(this.settings, this.configContext);

    if (!succeeded) {
      throw new ConfigError(
        `The project is set up, but the first build failed, so its outputs may be ` +
          `incomplete. Everything 'sous init' wrote is in place; fix what the build ` +
          `reported above and run 'sous build' again.`
      );
    }
  }
}
