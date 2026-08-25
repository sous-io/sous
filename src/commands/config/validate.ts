import { BaseCommand } from "../../base-command.js";
import {
  resolveCompilation,
  resolveRootScope,
  resolveTools,
  resolveWatchConfig,
} from "../../lib/settings.js";
import { footer, heading, showVars } from "../../utils/formatting.js";

export default class ConfigValidate extends BaseCommand {
  static description =
    "Validate the merged config: schema, then full variable resolution (fixpoint + substitution)";

  static examples = ["<%= config.bin %> config validate"];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    await this.parse(ConfigValidate);

    // Discovery, the config kernel, assertFlatConfig and zod validation have all
    // already run in BaseCommand.init(); a failure there exits before we get here.
    // Running the resolvers now surfaces the errors validation alone cannot:
    // fixpoint cycles, undefined ${vars}, and unresolved substitutions. Any
    // ConfigError they throw is rendered by BaseCommand.catch (non-zero exit).
    const rootScope = resolveRootScope(this.settings, this.configContext);
    resolveCompilation(this.settings, rootScope);
    const tools = resolveTools(this.settings, rootScope);
    resolveWatchConfig(this.settings, rootScope);

    const layerCount = this.configContext.layerPaths?.length ?? 1;
    const targetCount = this.settings.compilation?.targets.length ?? 0;
    const toolNames = Object.keys(tools);

    heading("Config is valid");
    showVars({
      "Config File": this.configContext.configPath,
      Layers: layerCount,
      Targets: targetCount,
      Tools: toolNames.length > 0 ? toolNames.join(", ") : "(none)",
    });

    footer();
  }
}
