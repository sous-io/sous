import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { CompilationService } from "../lib/markdown-compiler.js";
import { resolveProjectCompilation, resolveRootScope, resolveWatchConfig } from "../lib/settings.js";
import { StateService } from "../lib/state.js";
import { WatchService } from "../lib/watch-service.js";
import { displayError, footer, heading, log, showCommandVars } from "../utils/formatting.js";

export default class Compile extends BaseCommand {
  static description = "Compile markdown templates into output files";

  static examples = [
    "<%= config.bin %> compile",
    "<%= config.bin %> compile --project volta",
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

    const project = this.resolveProject(flags.project);
    const rootScope = resolveRootScope(this.settings);
    const config = resolveProjectCompilation(project, rootScope);

    if (!config) {
      displayError(`Project '${project.key}' has no compilation config`);
      this.exit(1);
    }

    const stateService = new StateService();
    const stateFilePath = stateService.getFilePath(project.key, rootScope);

    showCommandVars({
      Project: project.name,
      Strict: flags.strict,
      Rebuild: flags.rebuild,
      "Dry Run": flags["dry-run"],
    });

    heading("Compiling");

    const compilerOptions = {
      strict: flags.strict,
      rebuild: flags.rebuild,
      dryRun: flags["dry-run"],
    };

    const compiler = new CompilationService(compilerOptions);
    const success = await compiler.compile(config!, stateFilePath);

    footer();

    if (!success && flags.strict && !flags.watch) {
      this.exit(1);
    }

    if (flags.watch) {
      const watchConfig = resolveWatchConfig(project, rootScope);
      const watchService = new WatchService();

      watchService.watch(watchConfig, async (changedFile) => {
        log(`\nChange detected: ${changedFile}`);
        heading("Recompiling");
        const recompiler = new CompilationService(compilerOptions);
        await recompiler.compile(config!, stateFilePath);
        footer();
      });

      await new Promise(() => {}); // keep process alive
    }
  }
}
