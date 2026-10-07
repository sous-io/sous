import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** The packaged template that ends in `{% showVars %}`, where the leak was found. */
const LIQUID_SKILL = path.join(
  repoRoot,
  "recipes/core/sous-skills/skills/about-liquid-templates/SKILL.tpl.md"
);

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 90_000;

/** The answer to the declared secret; its name sounds like nothing in particular. */
const DECLARED_SECRET = "declared-secret-7f9c2e";
/** A project value the heuristic must catch: no declaration, a secret-sounding name. */
const NAMED_SECRET = "named-secret-41d8aa";
/** A project value the heuristic must catch by its format alone. */
const FORMATTED_SECRET = "ghp_" + "Zx9".repeat(12);

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let projectRoot: string;
let sousDir: string;
let sousHome: string;

/** Runs `sous <args...>` through the real published bin, against this test's store. */
function sous(cwd: string, args: string[]): RunResult {
  const env = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("SOUS_VAR_")) delete env[key];
  }
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: "",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * A secret answer never lands in compiled output through a tag that dumps the
 * whole scope.
 *
 * A recipe declares a `secret: true, scope: local` variable and ships the real
 * `about-liquid-templates` skill (which ends in `{% showVars %}`) plus a
 * settings module built with `{% exportScalarVarsJs %}`; the project's own
 * template dumps its scope too and carries two undeclared secrets in `_vars`.
 * After `sous build`, no compiled file holds any of the three values.
 */
describe("secret answers in compiled output", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-secret-answers-");
    sousHome = path.join(tmp.path, "sous-home");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");
    const fixtures = path.join(tmp.path, "fixtures");

    await buildFixtureRepo(fixtures, "fixtures", [
      {
        namespace: "workflow",
        name: "vault",
        version: "1.0.0",
        description: "Asks for a secret",
        variables: [
          {
            name: "vaultHandle",
            env: "VAULT_HANDLE",
            type: "string",
            prompt: "Which vault handle?",
            description: "The handle this recipe signs in with.",
            example: "handle-123",
            secret: true,
            scope: "local",
          },
        ],
        files: {
          "skills/about-liquid-templates/SKILL.tpl.md": fs.readFileSync(LIQUID_SKILL, "utf8"),
          "skills/vault/settings.tpl.mjs": "{% exportScalarVarsJs %}",
        },
        contents: [{ kind: "skills", include: ["skills/**/*"] }],
      },
    ]);

    writeFixtureFile(
      path.join(sousDir, "sous.config.js"),
      [
        "export const config = {",
        '  name: "Secret Answers Test Project",',
        "  _vars: {",
        '    projectRoot: "${sousDir}/..",',
        `    serviceApiKey: "${NAMED_SECRET}",`,
        `    deployNote: "${FORMATTED_SECRET}",`,
        "  },",
        '  repos: { "sous-recipes": { enabled: false } },',
        "  compilation: {",
        "    targets: [",
        "      {",
        '        entryPoint: "${projectRoot}/src/notes.tpl.md",',
        '        outputs: [{ destinationFile: "${projectRoot}/out/notes.md", _vars: {} }],',
        "      },",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    writeFixtureFile(path.join(projectRoot, "src", "notes.tpl.md"), "{% showVars %}\n");
    fs.writeFileSync(path.join(sousDir, ".env.local"), `VAULT_HANDLE=${DECLARED_SECRET}\n`, "utf8");

    expect(sous(projectRoot, ["repo", "add", fixtures, "--trust"]).status).toBe(0);
    expect(sous(projectRoot, ["subscribe", "workflow/vault", "--yes", "--no-build"]).status).toBe(0);
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * sous build   // -> no compiled file holds any secret; the dumps show "(hidden)"
   */
  it(
    "should keep every secret out of every compiled file",
    () => {
      const built = sous(projectRoot, ["build"]);
      expect(built.status, built.stdout + built.stderr).toBe(0);

      const compiledFiles = [
        ...filesUnder(path.join(projectRoot, ".claude")),
        ...filesUnder(path.join(projectRoot, "out")),
      ];
      expect(compiledFiles.length).toBeGreaterThanOrEqual(3);
      for (const file of compiledFiles) {
        const text = fs.readFileSync(file, "utf8");
        for (const secret of [DECLARED_SECRET, NAMED_SECRET, FORMATTED_SECRET]) {
          expect(text, `${file} holds a secret`).not.toContain(secret);
        }
      }

      const skill = fs.readFileSync(
        path.join(projectRoot, ".claude/skills/about-liquid-templates/SKILL.md"),
        "utf8"
      );
      expect(skill).toContain('"vaultHandle": "(hidden)"');
      expect(skill).toContain('"serviceApiKey": "(hidden)"');

      const settings = fs.readFileSync(
        path.join(projectRoot, ".claude/skills/vault/settings.mjs"),
        "utf8"
      );
      expect(settings).toContain("export default");
      expect(settings).not.toContain("vaultHandle");

      expect(fs.readFileSync(path.join(projectRoot, "out/notes.md"), "utf8")).toContain(
        '"deployNote": "(hidden)"'
      );
    },
    CLI_TIMEOUT
  );
});
