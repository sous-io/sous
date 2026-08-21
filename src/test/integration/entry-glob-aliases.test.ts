import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import type { ConfigContext, Settings } from "../../lib/settings.js";
import { resolveWatchConfig } from "../../lib/settings.js";
import { BuildService, type BuildOptions } from "../../lib/build-service.js";

describe("entryGlob alias resolution", () => {
  let tmp: TmpDir;
  let configContext: ConfigContext;
  let outDir: string;

  /** Runs build() for the "proj" project with the test's ConfigContext attached. */
  function build(
    service: BuildService,
    settings: Settings,
    options: BuildOptions = {}
  ): Promise<boolean> {
    return service.build("proj", settings, { ...options, configContext });
  }

  beforeEach(() => {
    tmp = makeTmpDir();
    configContext = {
      sousDir: tmp.path,
      configPath: path.join(tmp.path, "sous.config.js"),
    };
    outDir = path.join(tmp.path, "out");

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  /** Creates <root>/skills/demo/SKILL.md and returns root. */
  function makeSkillTree(rootName: string): string {
    const root = path.join(tmp.path, rootName);
    const skillDir = path.join(root, "skills", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo skill\n", "utf8");
    return root;
  }

  /**
   * A user-defined alias works as an entryGlob prefix.
   *
   * Config: _aliases.team = <tmp>/team-prompts, target entryGlob
   * "team/skills/**\/*" → destinationDir out/. The alias base holds
   * skills/demo/SKILL.md; the inferred glob base is the static prefix
   * (…/skills), so the build must mirror it to out/demo/SKILL.md.
   */
  it("should expand a user-alias entryGlob and compile the matched files", async () => {
    const teamRoot = makeSkillTree("team-prompts");

    const settings: Settings = {
      _aliases: { team: teamRoot },
      projects: {
        proj: {
          name: "Test Project",
          compilation: {
            targets: [
              {
                entryGlob: "team/skills/**/*",
                outputs: [{ destinationDir: outDir }],
              },
            ],
          },
        },
      },
    };

    const service = new BuildService();
    const ok = await build(service, settings);

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(outDir, "demo", "SKILL.md"))).toBe(true);
  });

  /**
   * The built-in ~sous-shared alias works as an entryGlob prefix.
   *
   * ~sous-shared points at <sousRootPath>/shared-prompts; the test overrides
   * sousRootPath via root _vars (later-wins over the auto-injected CLI_ROOT)
   * so the alias resolves into a tmp tree instead of the real install.
   */
  it("should expand the built-in ~sous-shared alias via sousRootPath", async () => {
    const fakeRoot = path.join(tmp.path, "fake-sous-root");
    const sharedDir = path.join(fakeRoot, "shared-prompts", "skills", "demo");
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "SKILL.md"), "# Shared skill\n", "utf8");

    const settings: Settings = {
      _vars: { sousRootPath: fakeRoot },
      projects: {
        proj: {
          name: "Test Project",
          compilation: {
            targets: [
              {
                entryGlob: "~sous-shared/skills/**/*",
                outputs: [{ destinationDir: outDir }],
              },
            ],
          },
        },
      },
    };

    const service = new BuildService();
    const ok = await build(service, settings);

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(outDir, "demo", "SKILL.md"))).toBe(true);
  });

  /**
   * Alias bases fall through in order: the first base that matches any files
   * wins, mirroring the first-existing-wins rule of @include resolution.
   *
   * Alias "layered" = [emptyRoot, fullRoot]. emptyRoot exists but holds no
   * skills; fullRoot holds skills/demo/SKILL.md. The build must compile from
   * fullRoot.
   */
  it("should fall through to the next alias base when the first matches nothing", async () => {
    const emptyRoot = path.join(tmp.path, "empty-prompts");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const fullRoot = makeSkillTree("full-prompts");

    const settings: Settings = {
      _aliases: { layered: [emptyRoot, fullRoot] },
      projects: {
        proj: {
          name: "Test Project",
          compilation: {
            targets: [
              {
                entryGlob: "layered/skills/**/*",
                outputs: [{ destinationDir: outDir }],
              },
            ],
          },
        },
      },
    };

    const service = new BuildService();
    const ok = await build(service, settings);

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(outDir, "demo", "SKILL.md"))).toBe(true);
  });

  /**
   * resolveWatchConfig expands alias entryGlobs when given settings, so watch
   * mode watches the real alias bases rather than a bogus relative pattern.
   * Every base of the alias is watched (compile falls through between bases,
   * so a change in any of them can affect the build).
   */
  it("should expand alias entryGlobs in the watch config when settings are provided", () => {
    const teamRoot = path.join(tmp.path, "team-prompts");

    const settings: Settings = {
      _aliases: { team: teamRoot },
      projects: {
        proj: {
          name: "Test Project",
          compilation: {
            targets: [
              {
                entryGlob: "team/skills/**/*",
                outputs: [{ destinationDir: outDir }],
              },
            ],
          },
        },
      },
    };

    const watchConfig = resolveWatchConfig(settings.projects.proj, {}, "proj", settings);
    expect(watchConfig.globs).toEqual([path.join(teamRoot, "skills", "**", "*")]);

    // Without settings, the raw pattern passes through unchanged (old behavior).
    const legacy = resolveWatchConfig(settings.projects.proj, {}, "proj");
    expect(legacy.globs).toEqual(["team/skills/**/*"]);
  });
});
