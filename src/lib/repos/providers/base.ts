/**
 * The base class every built-in provider extends.
 *
 * It carries the plumbing no provider should repeat: running a subprocess
 * through the injectable runner, capturing what one printed, finding a token in
 * the environment or from the host's own command line tool, and pulling the
 * address out of a tool's output.
 *
 * It also answers the whole write path with a refusal. A provider that does not
 * declare the `submit` feature (the local one, for instance) inherits four
 * methods that raise a ConfigError naming the provider and what was asked of
 * it, so a caller that skips the feature check gets a sentence rather than a
 * `TypeError`.
 */

import { ConfigError } from "../../errors.js";
import {
  spawnCommand,
  tryCommand,
  type CommandResult,
  type CommandRunner,
} from "./git.js";
import type {
  AuthStatus,
  CanonicalRepo,
  ChangeProposal,
  FetchedIndex,
  ForkedRepo,
  ProposedChange,
  ProviderCli,
  ProviderFeature,
  ProviderId,
  ProviderOptions,
  RepoProvider,
} from "./provider.js";

/**
 * The first URL in a command's output, which is where a host's own tool prints
 * the thing it just created.
 *
 * firstUrlIn("https://github.com/o/r/pull/7\n"); // -> "https://github.com/o/r/pull/7"
 *
 * @param output - Whatever the command printed.
 */
export function firstUrlIn(output: string): string | undefined {
  const match = /https?:\/\/\S+/.exec(output);
  return match === null ? undefined : match[0];
}

/** Everything a provider inherits rather than writes for itself. */
export abstract class ProviderBase implements RepoProvider {
  abstract readonly id: ProviderId;
  abstract readonly features: ProviderFeature[];

  abstract matches(url: string): boolean;
  abstract canonicalize(url: string): CanonicalRepo;
  abstract fetchIndex(repo: CanonicalRepo, options?: ProviderOptions): Promise<FetchedIndex>;
  abstract fetchRecipeTree(
    repo: CanonicalRepo,
    recipePath: string,
    tag: string,
    destDir: string,
    options?: ProviderOptions
  ): Promise<void>;

  // --- Subprocess plumbing ---------------------------------------------------

  /**
   * The runner a call should use: the injected one when a caller supplied it,
   * and a real process otherwise. Tests substitute their own, which is why no
   * provider reaches for `spawn` directly.
   *
   * @param options - The call's options.
   */
  protected runnerFor(options: ProviderOptions): CommandRunner {
    return options.run ?? spawnCommand;
  }

  /**
   * Runs a command and hands back everything it reported, including a non-zero
   * exit. A command that cannot be started at all comes back as exit code 127.
   *
   * @param command - The executable to run.
   * @param args - Its arguments, already split.
   * @param options - The call's options; `cwd` and `run` are used.
   */
  protected async runCommand(
    command: string,
    args: string[],
    options: ProviderOptions = {}
  ): Promise<CommandResult> {
    return this.runnerFor(options)(command, args, { cwd: options.cwd });
  }

  /**
   * True when a command ran and exited successfully, whatever it printed. Used
   * for the checks whose answer is the exit code itself, such as `auth status`.
   *
   * @param command - The executable to run.
   * @param args - Its arguments.
   * @param options - The call's options.
   */
  protected async commandSucceeds(
    command: string,
    args: string[],
    options: ProviderOptions = {}
  ): Promise<boolean> {
    try {
      const result = await this.runCommand(command, args, options);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * A command's trimmed standard output, or undefined when it did not succeed,
   * is not installed, or printed nothing at all.
   *
   * @param command - The executable to run.
   * @param args - Its arguments.
   * @param options - The call's options.
   */
  protected async capturedOutput(
    command: string,
    args: string[],
    options: ProviderOptions = {}
  ): Promise<string | undefined> {
    return tryCommand(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  }

  /**
   * Finds a host token: the environment first, then the host's own command line
   * tool when it is installed and signed in. Undefined is a normal answer,
   * because a public repository needs no token at all.
   *
   * @param envName - The environment variable to read, such as `GITHUB_TOKEN`.
   * @param args - The arguments that make the tool print a token.
   * @param options - Environment and subprocess runner overrides.
   */
  protected async findToken(
    envName: string,
    args: string[],
    options: ProviderOptions = {}
  ): Promise<string | undefined> {
    const env = options.env ?? process.env;
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
    if (this.cli === undefined) return undefined;
    return this.capturedOutput(this.cli.command, args, options);
  }

  // --- The write path, refused unless a provider overrides it ----------------

  /**
   * The command line tool this provider drives, and what its proposals are
   * called. Both are declared by the provider that has them; `declare` here
   * only tells the type system they may exist, so a subclass's own field is the
   * one that ends up on the instance.
   */
  declare readonly cli?: ProviderCli;
  declare readonly proposalNoun?: string;

  async authStatus(_options: ProviderOptions = {}): Promise<AuthStatus> {
    throw this.unsupported("submit", "check whether you are signed in to it");
  }

  async canPush(
    _repo: CanonicalRepo,
    _options: ProviderOptions = {}
  ): Promise<boolean | undefined> {
    throw this.unsupported("submit", "check whether you can push to it");
  }

  async fork(_repo: CanonicalRepo, _options: ProviderOptions = {}): Promise<ForkedRepo> {
    throw this.unsupported("submit", "fork it on your behalf");
  }

  async proposeChange(
    _repo: CanonicalRepo,
    _proposal: ChangeProposal,
    _options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    throw this.unsupported("submit", "propose a change to it");
  }

  /**
   * The refusal a provider gives when it is asked for something it never
   * claimed. It names the provider and the feature, so the caller learns why
   * rather than only that.
   *
   * @param feature - The feature the call belongs to.
   * @param what - What was being attempted, in plain language.
   */
  protected unsupported(feature: ProviderFeature, what: string): ConfigError {
    return new ConfigError(
      `The '${this.id}' provider does not support the '${feature}' feature, so sous cannot ` +
        `${what}.\n` +
        `  A provider answers only what its features promise; this one promises ` +
        `${this.features.map((entry) => `'${entry}'`).join(", ")}.`
    );
  }
}
