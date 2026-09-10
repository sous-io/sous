import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { CompilationService } from "../lib/markdown-compiler.js";
import { resolveCompilation, resolveRootScope } from "../lib/settings.js";
import {
  resolveRecipeTargets,
  resolveStateFilePath,
  withRecipeTargets,
} from "../lib/build-service.js";
import { createProjectNamespaceResolver } from "../lib/repos/locked-namespace-resolver.js";
import { describeLinkedRepos } from "../lib/repos/links.js";
import { buildReloadWatchConfig, startConfigReloadWatch } from "../lib/watch-loop.js";
import { WatchService } from "../lib/watch-service.js";
import {
  displayError,
  footer,
  heading,
  log,
  showCommandVars,
  warning,
} from "../utils/formatting.js";

export default class Compile extends BaseCommand {
  static description = "Compile markdown templates into output files";

  static examples = [
    "<%= config.bin %> compile",
    "<%= config.bin %> compile --rebuild",
    "<%= config.bin %> compile --dry-run",
    "<%= config.bin %> compile --strict",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    strict: Flags.boolean({
      description: "Fail immediately on any error",
      default: false,
    }),
    rebuild: Flags.boolean({
      description: "Ignore cached hashes and reprocess all outputs",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be written without making changes",
      default: false,
    }),
    watch: Flags.boolean({
      char: "w",
      description: "Watch source files and recompile on changes",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Compile);

    // The recipes this project subscribes to contribute compile targets
    // alongside its own; both go through the same compiler.
    const withRecipes = () => {
      const scope = resolveRootScope(this.settings, this.configContext);
      const recipes = resolveRecipeTargets(this.settings, scope, this.configContext);
      for (const notice of recipes.warnings) warning(notice);
      return withRecipeTargets(
        resolveCompilation(this.settings, scope),
        recipes,
        this.settings,
        scope
      );
    };

    for (const line of describeLinkedRepos(this.configContext.sousDir)) log(line);

    const config = withRecipes();

    if (!config) {
      displayError(`No compilation config found in ${this.configContext.configPath}`);
      this.exit(1);
    }

    const stateFilePath = resolveStateFilePath(this.settings, this.configContext);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Strict: flags.strict,
      Rebuild: flags.rebuild,
      "Dry Run": flags["dry-run"],
    });

    heading("Compiling");

    // Rebuilt on every compile rather than captured once: a watch-mode reload
    // may follow a subscribe, and the lockfile is what this reads.
    const namespaceResolver = () =>
      createProjectNamespaceResolver({
        sousDir: this.configContext.sousDir,
        settings: this.settings,
      });

    const compilerOptions = {
      strict: flags.strict,
      rebuild: flags.rebuild,
      dryRun: flags["dry-run"],
    };

    const compiler = new CompilationService({
      ...compilerOptions,
      namespaceResolver: namespaceResolver(),
    });
    const success = await compiler.compile(config!, stateFilePath);

    footer();

    if (!success && flags.strict && !flags.watch) {
      this.exit(1);
    }

    if (flags.watch) {
      const watchService = new WatchService();

      // Recompiles using the command's CURRENT settings. Called for partial
      // rebuilds (a changed source) and, after a clean reload, for full
      // rebuilds. The compilation config and state-file path are re-resolved
      // each time so a config reload takes effect. Owns the "Recompiling"
      // heading/footer. (`changedFile` is accepted for parity with build and
      // logged by the watch loop; compile always does a full recompile.)
      const rebuild = async (_changedFile?: string) => {
        const currentConfig = withRecipes();
        if (!currentConfig) {
          displayError(`No compilation config found in ${this.configContext.configPath}`);
          return;
        }
        const currentStateFilePath = resolveStateFilePath(this.settings, this.configContext);
        heading("Recompiling");
        const recompiler = new CompilationService({
          ...compilerOptions,
          namespaceResolver: namespaceResolver(),
        });
        await recompiler.compile(currentConfig, currentStateFilePath);
        footer();
      };

      startConfigReloadWatch({
        watchService,
        buildWatchConfig: () => buildReloadWatchConfig(this.settings, this.configContext),
        rebuild,
        reloadConfig: () => this.reloadDiscoveredConfig(),
      });

      await new Promise(() => {}); // keep process alive
    }
  }
}
