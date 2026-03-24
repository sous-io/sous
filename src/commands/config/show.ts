import { BaseCommand } from "../../base-command.js";
import { log } from "../../utils/formatting.js";

export default class ConfigShow extends BaseCommand {
  static description = "Show the active profile and its configuration";

  static examples = ["<%= config.bin %> config show"];

  protected get requiresSettings(): boolean {
    return false;
  }

  async run(): Promise<void> {
    await this.parse(ConfigShow);
    log(`profile: ${this.profileName}`);
    log(JSON.stringify(this.profile, null, 2));
  }
}
