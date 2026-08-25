import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { CompilationService } from "../lib/markdown-compiler.js";
import { resolveCompilation, resolveRootScope, resolveWatchConfig } from "../lib/settings.js";
import { resolveStateFilePath } from "../lib/build-service.js";
import { WatchService } from "../lib/watch-service.js";
import { displayError, footer, heading, log, showCommandVars } from "../utils/formatting.js";

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

    const rootScope = resolveRootScope(this.settings, this.configContext);
    const config = resolveCompilation(this.settings, rootScope);

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
      const watchConfig = resolveWatchConfig(this.settings, rootScope);
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
