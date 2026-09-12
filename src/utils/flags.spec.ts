import { describe, it, expect } from "vitest";
import { Args, Command } from "@oclif/core";
import { Config } from "@oclif/core";
import { aliasSuffix, confirmationFlag, CONFIRMATION_DESCRIPTION } from "./flags.js";

/**
 * How long a test that parses through a real oclif config may take. Loading
 * the config reads the package manifest from disk, which is well past the
 * default limit when the whole suite is running at once.
 */
const PARSE_TIMEOUT = 30_000;

/** Strips ANSI escape codes, so assertions do not depend on whether color is on. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Parses a fake command's flags the way oclif does at runtime, so the aliases
 * declared by the factory are exercised by the real parser rather than merely
 * inspected as data.
 *
 * @param flags - The command's flag map.
 * @param argv - The arguments to parse.
 */
async function parseFlags(
  flags: Record<string, unknown>,
  argv: string[]
): Promise<Record<string, unknown>> {
  class Fake extends Command {
    static flags = flags as never;
    static args = {} as Record<string, ReturnType<typeof Args.string>>;
    async run(): Promise<void> {}
  }
  const config = await Config.load(process.cwd());
  const command = new Fake(argv, config);
  const parsed = await command.parse(Fake as never, argv);
  return (parsed as { flags: Record<string, unknown> }).flags;
}

describe("aliasSuffix()", () => {
  /**
   * aliasSuffix should render every alternate spelling of a flag in one
   * parenthetical, short characters first, so a help screen can name them
   * without giving each one a line of its own.
   *
   * aliasSuffix(["force", "trust"], ["f"]);
   * // -> " (also -f, --force, --trust)"
   */
  it("should list char aliases before long aliases", () => {
    expect(strip(aliasSuffix(["force", "trust"], ["f"]))).toBe(
      " (also -f, --force, --trust)"
    );
  });

  /**
   * aliasSuffix should render nothing at all when a flag has no alternate
   * spellings, rather than an empty parenthetical.
   *
   * aliasSuffix([], []);
   * // -> ""
   */
  it("should render an empty string when there are no aliases", () => {
    expect(aliasSuffix([], [])).toBe("");
  });
});

describe("confirmationFlag()", () => {
  /**
   * The default flag is `--yes`, with `-y` as its character, and it accepts
   * `--force` and `-f` as aliases. Its description ends with the generated
   * suffix naming those spellings.
   *
   * confirmationFlag();
   * // -> boolean flag, char 'y', aliases ['force'], charAliases ['f']
   */
  it("should default to --yes with --force and -f as aliases", () => {
    const flag = confirmationFlag();

    expect(flag.char).toBe("y");
    expect(flag.aliases).toEqual(["force"]);
    expect(flag.charAliases).toEqual(["f"]);
    expect(flag.default).toBe(false);
    expect(strip(flag.description ?? "")).toBe(
      `${CONFIRMATION_DESCRIPTION} (also -f, --force)`
    );
  });

  /**
   * An extra alias is appended to the built-in spellings, so the commands that
   * perform the trust ceremony can keep the word `--trust` without it becoming
   * a second, separate flag.
   *
   * confirmationFlag({ extraAliases: ["trust"] });
   * // -> aliases ['force', 'trust']
   */
  it("should append extra aliases and name them in the suffix", () => {
    const flag = confirmationFlag({ extraAliases: ["trust"] });

    expect(flag.aliases).toEqual(["force", "trust"]);
    expect(strip(flag.description ?? "")).toContain("(also -f, --force, --trust)");
  });

  /**
   * Filed under `force` (which `clear` does), the primary and the alias swap
   * places: `-f`/`--force` is the flag, and `-y`/`--yes` are its aliases.
   *
   * confirmationFlag({ primary: "force" });
   * // -> char 'f', aliases ['yes'], charAliases ['y']
   */
  it("should swap the spellings when force is the primary one", () => {
    const flag = confirmationFlag({ primary: "force" });

    expect(flag.char).toBe("f");
    expect(flag.aliases).toEqual(["yes"]);
    expect(flag.charAliases).toEqual(["y"]);
    expect(strip(flag.description ?? "")).toContain("(also -y, --yes)");
  });

  /**
   * Every spelling has to reach the same parsed value, because that is the
   * whole point of making them aliases rather than separate flags.
   *
   * parse(['--trust']) // -> { yes: true }
   * parse(['-f'])      // -> { yes: true }
   */
  it("should set the primary flag from every one of its spellings", async () => {
    const flags = { yes: confirmationFlag({ extraAliases: ["trust"] }) };

    for (const spelling of ["--yes", "-y", "--force", "-f", "--trust"]) {
      const parsed = await parseFlags(flags, [spelling]);
      expect(parsed.yes, `${spelling} should set yes`).toBe(true);
    }

    const none = await parseFlags(flags, []);
    expect(none.yes).toBe(false);
  }, PARSE_TIMEOUT);

  /**
   * `clear` spells the flag `--force`, and `--yes`/`-y` must land on that same
   * key so the two commands behave identically.
   *
   * parse(['-y']) // -> { force: true }
   */
  it("should set a force-primary flag from the yes spellings too", async () => {
    const flags = { force: confirmationFlag({ primary: "force" }) };

    for (const spelling of ["--force", "-f", "--yes", "-y"]) {
      const parsed = await parseFlags(flags, [spelling]);
      expect(parsed.force, `${spelling} should set force`).toBe(true);
    }
  }, PARSE_TIMEOUT);
});
