/**
 * Unit tests for the trust layer. The prompt and the console are both injected,
 * so no test here waits on a terminal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TrustService } from "./trust.js";
import { REPOS_LAYER_FILENAME, readManagedLayer } from "./managed-layer.js";
import type { MissingRepo } from "./resolver.js";
import type { Settings } from "../settings.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";

/** Strips ANSI escape codes, so assertions are not brittle against color. */
const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("TrustService", () => {
  let tmp: TmpDir;
  let sousDir: string;
  let written: string[];

  beforeEach(() => {
    tmp = makeTmpDir("sous-trust-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    written = [];
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** Builds a service whose prompt answers as the test says. */
  function makeService(options: {
    answer?: boolean;
    interactive?: boolean;
    settings?: Settings;
  } = {}) {
    const asked: string[] = [];
    const service = new TrustService({
      sousDir,
      interactive: options.interactive ?? true,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ask: async (message) => {
        asked.push(message);
        return options.answer ?? true;
      },
      write: (message) => written.push(strip(message)),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    return { service, asked };
  }

  /** One missing repository, with a URL and provenance. */
  const missingWithUrl: MissingRepo[] = [
    {
      name: "vendor-recipes",
      url: "https://github.com/vendor/recipes",
      requiredBy: [{ ref: "vendor-recipes:core/partials", requestedBy: "workflow/task-files" }],
    },
  ];

  /**
   * addRepo should write the repository into the managed layer with its
   * provenance, which is what trusting one means.
   *
   * addRepo({ name: "team-recipes", url }) // -> conf.d/500-repos.jsonc holds it
   */
  it("should write an added repository into the managed layer", () => {
    const { service } = makeService();

    service.addRepo({ name: "team-recipes", url: "https://github.com/team/recipes" });

    const layer = readManagedLayer(sousDir, REPOS_LAYER_FILENAME) as {
      repos: Record<string, { url: string; addedBy: string; addedAt: string }>;
    };
    expect(layer.repos["team-recipes"]).toEqual({
      url: "https://github.com/team/recipes",
      addedBy: "user",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(service.isTrusted("team-recipes", { repos: layer.repos } as unknown as Settings)).toBe(
      true
    );
  });

  /**
   * removeRepo should take the entry out of the managed layer, withdrawing the
   * trust.
   */
  it("should remove a repository from the managed layer", () => {
    const { service } = makeService();
    service.addRepo({ name: "team-recipes", url: "https://github.com/team/recipes" });

    service.removeRepo("team-recipes");

    expect(service.listManaged()).toEqual({});
  });

  /**
   * A repository written by hand in the primary config is not sous's to remove,
   * and the error should say where to remove it instead.
   */
  it("should refuse to remove a repository sous did not write", () => {
    const settings = {
      repos: { "hand-written": { url: "https://github.com/a/b" } },
    } as unknown as Settings;
    const { service } = makeService({ settings });

    expect(() => service.removeRepo("hand-written")).toThrow(
      /written in this project's own config/
    );
  });

  /**
   * The consolidated notice names every repository, its URL and the recipe that
   * requires it, and states plainly what trusting it means.
   */
  it("should show every repository, its URL and its provenance in one notice", async () => {
    const { service, asked } = makeService({ answer: true });

    await service.confirmTrust(missingWithUrl);

    const notice = written.join("\n");
    expect(notice).toContain("vendor-recipes");
    expect(notice).toContain("https://github.com/vendor/recipes");
    expect(notice).toContain(
      "vendor-recipes:core/partials required by 'workflow/task-files'"
    );
    expect(notice).toContain("trusts every namespace and every recipe in it");
    expect(asked).toHaveLength(1);
  });

  /**
   * The notice is given room of its own: a blank line before it, so it never
   * lands pressed under whatever the command printed last, and a blank line
   * after it, so the question that follows stands on its own.
   */
  it("should open and close the notice with a blank line", async () => {
    const { service } = makeService({ answer: true });

    await service.confirmTrust(missingWithUrl);

    expect(written[0]?.trim()).toBe("");
    expect(strip(written.at(-1) ?? "").split("\n").at(-1)?.trim()).toBe("");
  });

  /**
   * Accepting the question adds every repository whose URL sous knows.
   */
  it("should add the accepted repositories whose URL is known", async () => {
    const { service } = makeService({ answer: true });

    const result = await service.confirmTrust(missingWithUrl);

    expect(result.added).toEqual(["vendor-recipes"]);
    expect(result.needUrl).toEqual([]);
    expect(service.listManaged()["vendor-recipes"]).toMatchObject({
      url: "https://github.com/vendor/recipes",
      addedBy: "workflow/task-files",
    });
  });

  /**
   * A repository several recipes need records every one of them. Keeping only
   * the first left removal hygiene looking at an incomplete picture, so a
   * repository three recipes need could read as needed by one.
   *
   * confirmTrust([{ name, url, requiredBy: [a, b] }]);
   * // -> the entry records "workflow/a, workflow/b"
   */
  it("should record every recipe that required a repository, not just the first", async () => {
    const { service } = makeService({ answer: true });

    await service.confirmTrust([
      {
        name: "vendor-recipes",
        url: "https://github.com/vendor/recipes",
        requiredBy: [
          { ref: "vendor-recipes:core/partials", requestedBy: "workflow/b" },
          { ref: "vendor-recipes:core/other", requestedBy: "workflow/a" },
          { ref: "vendor-recipes:core/partials", requestedBy: "workflow/a" },
        ],
      },
    ]);

    expect(service.listManaged()["vendor-recipes"]).toMatchObject({
      addedBy: "workflow/a, workflow/b",
    });
  });

  /**
   * A recipe names a repository by its short name only, so sous may not know a
   * URL. Those are reported rather than guessed at.
   */
  it("should report a repository whose URL nothing knows", async () => {
    const { service } = makeService({ answer: true });

    const result = await service.confirmTrust([
      {
        name: "vendor-recipes",
        requiredBy: [{ ref: "vendor-recipes:core/partials", requestedBy: "workflow/task-files" }],
      },
    ]);

    expect(result.needUrl).toEqual(["vendor-recipes"]);
    expect(service.listManaged()).toEqual({});
  });

  /**
   * Any refusal aborts: sous installs a dependency closure whole or not at all.
   */
  it("should abort when trust is declined", async () => {
    const { service } = makeService({ answer: false });

    await expect(service.confirmTrust(missingWithUrl)).rejects.toThrow(/Nothing was installed/);
    expect(service.listManaged()).toEqual({});
  });

  /**
   * A non-interactive run cannot answer a question, so it fails hard, naming
   * every repository and the exact command that grants trust.
   */
  it("should fail hard without a terminal, naming the command that grants trust", async () => {
    const { service } = makeService({ interactive: false });

    const promise = service.confirmTrust(missingWithUrl);
    await expect(promise).rejects.toThrow(/not running where it can ask/);
    await promise.catch((error: unknown) => {
      expect((error as Error).message).toContain(
        "sous repo add https://github.com/vendor/recipes --name vendor-recipes --trust"
      );
    });
  });

  /**
   * The `--trust` flag acknowledges without asking, which is how a scripted run
   * proceeds deliberately.
   */
  it("should add without asking when the trust flag is passed", async () => {
    const { service, asked } = makeService({ interactive: false });

    const result = await service.confirmTrust(missingWithUrl, { trustFlag: true });

    expect(asked).toEqual([]);
    expect(written).toEqual([]);
    expect(result.added).toEqual(["vendor-recipes"]);
  });

  /**
   * With nothing missing there is nothing to ask about.
   */
  it("should do nothing when no repository is missing", async () => {
    const { service, asked } = makeService();

    const result = await service.confirmTrust([]);

    expect(result).toEqual({ accepted: [], added: [], needUrl: [] });
    expect(asked).toEqual([]);
  });
});
