import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { BuildService } from "../lib/build-service.js";
import { PidService } from "../lib/pid-service.js";
import { resolveRootScope } from "../lib/settings.js";
import { buildReloadWatchConfig, startConfigReloadWatch } from "../lib/watch-loop.js";
import type { WatchHandle } from "../lib/watch-service.js";
import { WatchService } from "../lib/watch-service.js";
import { footer, heading, log, showCommandVars } from "../utils/formatting.js";

export default class Build extends BaseCommand {
  static description = "Compile outputs and prune stale files (compile + prune)";

  static examples = [
    "<%= config.bin %> build",
    "<%= config.bin %> build --no-prune",
    "<%= config.bin %> build --rebuild",
    "<%= config.bin %> build --dry-run",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    "no-prune": Flags.boolean({
      description: "Skip the prune step",
      default: false,
    }),
    "no-compile": Flags.boolean({
      description: "Skip the compile step (prune only)",
      default: false,
    }),
    rebuild: Flags.boolean({
      description: "Ignore cached hashes and reprocess all outputs",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be written/pruned without making changes",
      default: false,
    }),
    strict: Flags.boolean({
      description: "Fail on any compilation error",
      default: false,
    }),
    watch: Flags.boolean({
      char: "w",
      description: "Watch source files and rebuild on changes",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Build);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Rebuild: flags.rebuild,
      "Dry Run": flags["dry-run"],
      "No Compile": flags["no-compile"],
      "No Prune": flags["no-prune"],
    });

    heading("Building");

    const buildOptions = {
      strict: flags.strict,
      rebuild: flags.rebuild,
      dryRun: flags["dry-run"],
      noCompile: flags["no-compile"],
      noPrune: flags["no-prune"],
      configContext: this.configContext,
    };

    const buildService = new BuildService();
    const success = await buildService.build(this.settings, buildOptions);

    footer();

    if (!success && !flags.watch) {
      this.exit(1);
    }

    if (flags.watch) {
      const rootScope = resolveRootScope(this.settings, this.configContext);

      // --- PID file enforcement ---
      const pidService = new PidService();
      const pidFilePath = pidService.getFilePath(rootScope);
      await pidService.acquire(pidFilePath, this.projectLabel);

      const cleanup = async (watchHandle?: WatchHandle) => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        if (watchHandle) await watchHandle.stop();
        await pidService.release(pidFilePath);
      };

      process.on("SIGINT", () => { void cleanup().then(() => process.exit(0)); });
      process.on("SIGTERM", () => { void cleanup().then(() => process.exit(0)); });

      const watchService = new WatchService();

      // Reruns compile + prune with the command's current settings. Called for
      // partial rebuilds (with the changed file) and, after a clean reload, for
      // full rebuilds. Owns the "Rebuilding" heading/footer.
      const rebuild = async (changedFile?: string) => {
        heading("Rebuilding");
        await buildService.build(this.settings, {
          ...buildOptions,
          // --rebuild means full clean build on every trigger; skip partial optimisation
          changedFile: buildOptions.rebuild ? undefined : changedFile,
        });
        footer();
      };

      const { handle, triggerFullRebuild } = startConfigReloadWatch({
        watchService,
        buildWatchConfig: () => buildReloadWatchConfig(this.settings, this.configContext),
        rebuild,
        reloadConfig: () => this.reloadDiscoveredConfig(),
      });

      // Display the interactive prompt
      log("[ Press Q to quit  |  any other key: rebuild ]");

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        process.stdin.on("data", (key: string) => {
          // q, Q, or Ctrl+C → clean exit
          if (key === "q" || key === "Q" || key === "\u0003") {
            void cleanup(handle.current ?? undefined).then(() => process.exit(0));
            return;
          }
          // Any other key → trigger a full rebuild immediately (bypass debounce)
          void triggerFullRebuild("Manual rebuild triggered.");
        });
      }

      await new Promise(() => {}); // keep process alive
    }
  }
}
