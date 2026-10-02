import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { makeSettings } from "../utils/settings.js";
import type { ConfigContext } from "../../lib/settings.js";
import {
  BuildService,
  unincludedMemoriesWarning,
} from "../../lib/build-service.js";

const listed = vi.hoisted(() => ({ files: [] as Array<Record<string, string>> }));

vi.mock("../../lib/repos/recipe-memories.js", () => ({
  listMemories: () => listed.files,
  dependencyOrder: () => [],
}));

describe("the unincluded-memory warning inside a build", () => {
  let tmp: TmpDir;
  let configContext: ConfigContext;
  let printed: string[];

  beforeEach(() => {
    tmp = makeTmpDir("sous-memwarn-");
    configContext = { sousDir: tmp.path, configPath: path.join(tmp.path, "sous.config.js") };
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memory = path.join(tmp.path, "recipe", "memories", "tone.md");
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.writeFileSync(memory, "TONE\n");
    listed.files = [
      { recipe: "communication/tone", path: "communication/tone/tone.md", file: memory, relative: "memories/tone.md" },
    ];
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  /** A project whose one instruction source includes the given text. */
  function project(source: string) {
    const entry = path.join(tmp.path, "a.md");
    fs.writeFileSync(entry, source);
    return makeSettings({
      name: "Test Project",
      compilation: {
        targets: [{ entryPoint: entry, outputs: [{ destinationFile: path.join(tmp.path, "out.md") }] }],
      },
    });
  }

  /**
   * A full build whose outputs include no memory warns once, naming the file.
   *
   * a.md holds no include of the view -> "1 memory ... is not included"
   */
  it("should warn after a full build when no output includes a memory", async () => {
    const ok = await new BuildService().build(project("# Nothing\n"), { configContext });

    expect(ok).toBe(true);
    const text = printed.join("\n");
    expect(text).toContain("1 memory published by your subscribed recipes is not included in any output");
    expect(text).toContain("communication/tone: memories/tone.md");
  });

  /**
   * An include of the view counts, so the same build is silent.
   *
   * a.md holds "@#memories/**\/*.md" -> no warning
   */
  it("should stay silent when an output includes the memory through the view", async () => {
    const ok = await new BuildService().build(project("@#memories/**/*.md\n"), { configContext });

    expect(ok).toBe(true);
    expect(printed.join("\n")).not.toContain("not included in any output");
    expect(fs.readFileSync(path.join(tmp.path, "out.md"), "utf8")).toContain("TONE");
  });

  /**
   * A partial rebuild (one changed file, in watch mode) knows nothing about
   * the other outputs, so it never warns.
   *
   * build({ changedFile: a.md }) with no include -> no warning
   */
  it("should not warn in a partial rebuild", async () => {
    const settings = project("# Nothing\n");
    await new BuildService().build(settings, {
      configContext,
      changedFile: path.join(tmp.path, "a.md"),
    });

    expect(printed.join("\n")).not.toContain("not included in any output");
  });

  /**
   * The wording is complete sentences and names both fixes; nothing is said
   * when nothing is missing.
   *
   * unincludedMemoriesWarning([]) // -> undefined
   */
  it("should say nothing for an empty list and name both fixes otherwise", () => {
    expect(unincludedMemoriesWarning([])).toBeUndefined();
    const text = unincludedMemoriesWarning(listed.files as never);
    expect(text).toContain("@#memories/**/*.md");
    expect(text).toContain("recipes.memories.exclude");
  });
});
