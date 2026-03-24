import path from "node:path";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { BuildService } from "../lib/build-service.js";
import { PidService } from "../lib/pid-service.js";
import { CLI_ROOT, loadSettings, resolveRootScope, resolveScope, resolveWatchConfig } from "../lib/settings.js";
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

    const project = this.resolveProject(flags.project);

    showCommandVars({
      Project: project.name,
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
    };

    const buildService = new BuildService();
    const success = await buildService.build(project.key, this.settings, buildOptions);

    footer();

    if (!success && !flags.watch) {
      this.exit(1);
    }

    if (flags.watch) {
      const configPath = this.profile.defaultConfigPath;

      const rootScope = resolveRootScope(this.settings);
      const projectScope = resolveScope(project._vars ?? {}, rootScope);

      // --- PID file enforcement ---
      const pidService = new PidService();
      const pidFilePath = pidService.getFilePath(project.key, projectScope);
      await pidService.acquire(pidFilePath);

      let isRebuilding = false;

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

      /**
       * Builds a WatchConfig from current settings, injecting the config file path
       * and the templating directory into fullRebuildPaths.
       */
      const buildWatchConfig = () => {
        const currentRootScope = resolveRootScope(this.settings);
        const config = resolveWatchConfig(project, currentRootScope);
        config.fullRebuildPaths = [
          ...(config.fullRebuildPaths ?? []),
          ...(configPath ? [configPath] : []),
          path.join(CLI_ROOT, "src", "templating"),
        ];
        return config;
      };

      /** Starts a new watcher and updates the shared handle reference. */
      const startWatcher = (handle: { current: WatchHandle | null }) => {
        const watchConfig = buildWatchConfig();
        handle.current = watchService.watch(watchConfig, async (event) => {
          if (event.type === "partial") {
            if (isRebuilding) return;
            isRebuilding = true;
            log(`\nChange detected: ${event.filePath}`);
            heading("Rebuilding");
            await buildService.build(project.key, this.settings, {
              ...buildOptions,
              // --rebuild means full clean build on every trigger; skip partial optimisation
              changedFile: buildOptions.rebuild ? undefined : event.filePath,
            });
            footer();
            isRebuilding = false;
          } else {
            // Full rebuild: stop current watcher, reload settings, restart
            if (isRebuilding) return;
            isRebuilding = true;
            log(`\nConfig changed (${event.filePath}), reloading settings and restarting watcher...`);
            await handle.current!.stop();

            if (configPath) {
              this.settings = await loadSettings(configPath);
            }

            heading("Rebuilding");
            await buildService.build(project.key, this.settings, buildOptions);
            footer();
            isRebuilding = false;

            startWatcher(handle);
          }
        });
      };

      const handle: { current: WatchHandle | null } = { current: null };
      startWatcher(handle);

      const triggerFullRebuild = async (reason: string) => {
        if (isRebuilding) return;
        isRebuilding = true;
        log(`\n${reason}`);
        heading("Rebuilding");
        await buildService.build(project.key, this.settings, buildOptions);
        footer();
        isRebuilding = false;
      };

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
