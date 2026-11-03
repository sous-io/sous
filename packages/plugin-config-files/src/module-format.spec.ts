import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const moduleFormat = fileURLToPath(new URL("./module-format.ts", import.meta.url));
const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** Imports a `.js` config in a fresh Node process, in a project whose package.json is `packageJson`. */
function importConfig(packageJson: object | undefined, source: string): { code: number | null; stdout: string; stderr: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sous-module-format-"));

    directories.push(directory);

    if (packageJson !== undefined) {
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(packageJson));
    }

    const config = path.join(directory, "sous.config.js");
    const runner = path.join(directory, "run.mjs");

    fs.writeFileSync(config, source);
    fs.writeFileSync(
        runner,
        [
            `import { declareConfigModule } from ${JSON.stringify(pathToFileURL(moduleFormat).href)};`,
            `const url = ${JSON.stringify(pathToFileURL(config).href)};`,
            `declareConfigModule(${JSON.stringify(config)}, url);`,
            "const loaded = await import(url);",
            "console.log(JSON.stringify(loaded.config ?? loaded.default));",
        ].join("\n"),
    );

    const result = spawnSync(process.execPath, [runner], { encoding: "utf8" });

    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const esm = 'export const config = { name: "esm" };\n';
const cjs = 'module.exports = { name: "cjs" };\n';

describe("declareConfigModule", () => {
    it("loads an ES module config when package.json has no type, without Node's warning", () => {
        const result = importConfig({ name: "p" }, esm);

        expect(result.stderr).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
        expect(result.stdout.trim()).toBe('{"name":"esm"}');
    });

    it('loads an ES module config when package.json says "type": "commonjs"', () => {
        const result = importConfig({ name: "p", type: "commonjs" }, esm);

        expect(result.stderr).not.toContain("Unexpected token 'export'");
        expect(result.stdout.trim()).toBe('{"name":"esm"}');
    });

    it('still loads a CommonJS config as CommonJS when package.json says "type": "commonjs"', () => {
        const result = importConfig({ name: "p", type: "commonjs" }, cjs);

        expect(result.stdout.trim()).toBe('{"name":"cjs"}');
    });
});
