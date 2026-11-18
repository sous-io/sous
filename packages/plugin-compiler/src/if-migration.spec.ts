import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ifMigration, migrateIfConditions } from "./if-migration.js";
import { ifReplacement } from "./schema.js";

let root: string;
let sousDir: string;
let confDir: string;

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-if-migration-")));
    sousDir = path.join(root, ".sous");
    confDir = path.join(sousDir, "conf.d");
    fs.mkdirSync(confDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const write = (file: string, text: string) => fs.writeFileSync(file, text, "utf8");
const read = (file: string) => fs.readFileSync(file, "utf8");

describe("the _if migration", () => {
    /**
     * In a JSONC config, each output's `_if` becomes the `$if` expression that replaces it; the
     * rest of the file, comments included, stays byte for byte, and a second run changes nothing.
     *
     * { "_if": { "stage": { "eq": "prod" } }, "destinationFile": "prod.md" }
     * -> { "$if": { "expr": "stage == 'prod'", "then": { "destinationFile": "prod.md" } } }
     */
    it("should rewrite _if in a JSONC config surgically, and change nothing the second time", () => {
        const config = path.join(sousDir, "sous.config.jsonc");
        const before = [
            "// The project's config.",
            "{",
            '  "name": "demo", // its name',
            '  "compilation": {',
            '    "targets": [',
            "      {",
            '        "entryPoint": "a.md",',
            '        "outputs": [',
            '          { "destinationFile": "always.md" },',
            '          { "_if": { "stage": { "eq": "prod" } }, "destinationFile": "prod.md" }',
            "        ]",
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ].join("\n");

        write(config, before);

        const outcome = migrateIfConditions(sousDir, confDir);
        const after = read(config);
        const parsed = JSON.parse(after.replace(/\/\/.*$/gm, ""));

        expect(outcome.summary).toContain("One output's '_if' was rewritten");
        expect(parsed.compilation.targets[0].outputs).toEqual([
            { destinationFile: "always.md" },
            { $if: { expr: "stage == 'prod'", then: { destinationFile: "prod.md" } } },
        ]);
        expect(after.startsWith('// The project\'s config.\n{\n  "name": "demo", // its name\n')).toBe(true);
        expect(after).toContain('{ "destinationFile": "always.md" }');

        expect(migrateIfConditions(sousDir, confDir).summary).toBe("No output in the config uses '_if'.");
        expect(read(config)).toBe(after);
    });

    /**
     * A YAML layer in conf.d is rewritten too, keeping its comments; several conditions become one
     * expression joined by `and`.
     */
    it("should rewrite _if in a YAML layer, joining several conditions", () => {
        const layer = path.join(confDir, "500-outputs.yaml");

        write(
            layer,
            [
                "# outputs for production",
                "compilation:",
                "  targets:",
                "    - entryPoint: a.md",
                "      outputs:",
                "        - destinationFile: prod.md",
                "          _if:",
                "            stage: { eq: prod }",
                "            os: { eq: linux }",
                "",
            ].join("\n"),
        );

        migrateIfConditions(sousDir, confDir);

        const after = read(layer);

        expect(after.startsWith("# outputs for production\n")).toBe(true);
        expect(after).toContain("stage == 'prod' and os == 'linux'");
        expect(after).not.toContain("_if");
    });

    /**
     * An `_if` naming `env` or `host` is left alone and reported, since an expression reads those
     * names as Sous's own values.
     */
    it("should leave an _if on env or host alone and say why", () => {
        const config = path.join(sousDir, "sous.config.json");
        const text = `${JSON.stringify({ compilation: { targets: [{ entryPoint: "a.md", outputs: [{ _if: { env: { eq: "ci" } }, destinationFile: "ci.md" }] }] } }, null, 2)}\n`;

        write(config, text);

        const outcome = migrateIfConditions(sousDir, confDir);

        expect(read(config)).toBe(text);
        expect(outcome.details?.[0]).toContain("names 'env'");
    });

    /**
     * A config written as code is reported, with the line and the expression to write, and not
     * edited.
     */
    it("should report each _if in a JavaScript config with its line and replacement", () => {
        const config = path.join(sousDir, "sous.config.js");
        const text = ["export const config = {", "  compilation: { targets: [{ entryPoint: 'a.md', outputs: [", "    { _if: { stage: { eq: 'prod' } }, destinationFile: 'prod.md' },", "  ] }] },", "};", ""].join("\n");

        write(config, text);

        const outcome = migrateIfConditions(sousDir, confDir);

        expect(read(config)).toBe(text);
        expect(outcome.details).toEqual([`${config}:3: write the output as { $if: { expr: "stage == 'prod'", then: { ...the output without _if... } } }`]);
    });

    /** The migration belongs to the release after 1.0.19 and gives the same text as the config error. */
    it("should belong to the next release and agree with the config error's replacement", () => {
        expect(ifMigration.version).toBe("1.0.20");
        expect(ifReplacement({ _if: { stage: { eq: "prod" } }, destinationFile: "p.md" })).toBe('{ "$if": { "expr": "stage == \'prod\'", "then": {"destinationFile":"p.md"} } }');
    });
});
