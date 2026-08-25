import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { ConfigCommand } from "../../config-command.js";
import { ConfigError, loadSettingsWithLayers } from "../../lib/settings.js";
import {
  isScalar,
  lookupPath,
  NOT_FOUND,
  parsePath,
  renderJson,
  truncateJson,
} from "../../lib/config-inspect.js";

export default class ConfigGet extends ConfigCommand {
  static description =
    "Print one value from the merged config by dot-path (e.g. compilation.targets[0].entryPoint)";

  static examples = [
    "<%= config.bin %> config get name",
    "<%= config.bin %> config get compilation.targets[0].entryPoint",
    "<%= config.bin %> config get compilation --layers",
  ];

  static args = {
    path: Args.string({
      description: "Dot-path into the config, with [n] for array indices",
      required: true,
    }),
  };

  static flags = {
    ...ConfigCommand.baseFlags,
    layers: Flags.boolean({
      description: "Show which config layer set the value (per-layer provenance)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigGet);
    const segments = parsePath(args.path);

    if (flags.layers) {
      await this.showLayers(args.path, segments);
      return;
    }

    const value = lookupPath(this.settings, segments);
    if (value === NOT_FOUND) {
      throw new ConfigError(
        `No value at config path '${args.path}'.\n` +
          `  It is not present in the merged config (${this.configContext.configPath}).\n` +
          `  Run 'xcv config show' to see the whole config.`
      );
    }

    // Scalars print raw (no quotes) so the output is directly usable; objects and
    // arrays print as pretty JSON, colorized only for a TTY.
    if (isScalar(value)) {
      process.stdout.write(`${String(value)}\n`);
    } else {
      process.stdout.write(`${renderJson(value, Boolean(process.stdout.isTTY))}\n`);
    }
  }

  /**
   * Prints one line per config layer whose cumulative snapshot CHANGED the value
   * at `pathStr`, showing old -> new (JSON-encoded, truncated). The first layer
   * counts as a change from (unset).
   */
  private async showLayers(pathStr: string, segments: (string | number)[]): Promise<void> {
    const { layers } = await loadSettingsWithLayers(this.discovered, { trace: true });
    const sousDir = this.configContext.sousDir;

    let previous: unknown = NOT_FOUND;
    let printedAny = false;

    for (const layer of layers) {
      const current = lookupPath(layer.config, segments);
      // JSON round-trip so structurally-equal values compare equal.
      const unchanged =
        current !== NOT_FOUND
          ? previous !== NOT_FOUND && JSON.stringify(current) === JSON.stringify(previous)
          : previous === NOT_FOUND;
      if (unchanged) continue;

      const rel = path.relative(sousDir, layer.path);
      const label = rel && !rel.startsWith("..") ? rel : layer.path;
      const oldStr = previous === NOT_FOUND ? "(unset)" : truncateJson(previous);
      const newStr = current === NOT_FOUND ? "(unset)" : truncateJson(current);
      process.stdout.write(`${label}: ${oldStr} -> ${newStr}\n`);

      previous = current;
      printedAny = true;
    }

    if (!printedAny) {
      throw new ConfigError(
        `No value at config path '${pathStr}' in any config layer.\n` +
          `  Run 'xcv config show' to see the whole merged config.`
      );
    }
  }
}
