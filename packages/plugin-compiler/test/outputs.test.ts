/**
 * What reaches the project: files copied byte for byte, executable sources kept executable.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { compileOnce, makeProject, type TestProject } from "./helpers.js";

let project: TestProject;

afterEach(() => {
    project?.remove();
});

/** Bytes that are not UTF-8 text: what a PNG starts with, and a lone continuation byte. */
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x0a, 0x40, 0x78, 0x2e, 0x6d, 0x64]);

describe("files reach the project byte for byte", () => {
    /** A binary file is copied unchanged: reading it as text would turn every invalid byte into three. */
    it("should copy a binary file unchanged", async () => {
        project = makeProject();
        const source = project.at("assets", "logo.png");

        fs.mkdirSync(project.at("assets"));
        fs.writeFileSync(source, BINARY);

        const { result } = await compileOnce(project, { targets: [{ entryPoint: source, outputs: [{ destinationDir: project.at("out") }] }] });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(project.at("out", "logo.png")).equals(BINARY)).toBe(true);
        expect(result.outputs[0]).toMatchObject({ action: "created", bytes: BINARY.length });
    });

    /** A second build leaves the copy alone, and a changed binary is copied again. */
    it("should leave an unchanged binary alone and copy a changed one", async () => {
        project = makeProject();
        const source = project.at("logo.png");
        const compilation = { targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("out", "logo.png") }] }] };

        fs.writeFileSync(source, BINARY);
        await compileOnce(project, compilation);

        const { result: again } = await compileOnce(project, compilation);

        expect(again.outputs[0]!.action).toBe("unchanged");

        // Differs only in invalid bytes, which read as text would be the same replacement character.
        const changed = Buffer.from(BINARY);

        changed[9] = 0xfd;
        fs.writeFileSync(source, changed);

        const { result: third } = await compileOnce(project, compilation);

        expect(third.outputs[0]!.action).toBe("updated");
        expect(fs.readFileSync(project.at("out", "logo.png")).equals(changed)).toBe(true);
    });

    /** Text that is not a template keeps its exact bytes too, a byte-order mark and CRLF included. */
    it("should copy text that includes nothing byte for byte", async () => {
        project = makeProject();
        const bytes = Buffer.from("﻿line one\r\nline two\r\n", "utf8");
        const source = project.at("notes.md");

        fs.writeFileSync(source, bytes);

        const { result } = await compileOnce(project, { targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("out", "notes.md") }] }] });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(project.at("out", "notes.md")).equals(bytes)).toBe(true);
    });
});

describe("executable sources stay executable", () => {
    /** A templated script keeps its source's executable mode, whatever its name. */
    it("should keep a templated script executable", async () => {
        project = makeProject();
        const source = project.write("probe-info.tpl.py", "print('{{ who }}')\n");

        fs.chmodSync(source, 0o755);

        const { result } = await compileOnce(project, {
            targets: [{ entryPoint: source, outputs: [{ destinationDir: project.at("out"), _vars: { who: "me" } }] }],
        });

        expect(result.ok).toBe(true);
        expect(project.read("out/probe-info.py")).toBe("print('me')\n");
        expect(fs.statSync(project.at("out", "probe-info.py")).mode & 0o777).toBe(0o755);
    });

    /** A template that is not executable gives an output with the default mode; `.sh` is still made executable. */
    it("should leave a template that is not executable with the default mode", async () => {
        project = makeProject();
        const plain = project.write("notes.tpl.md", "x");
        const script = project.write("run.tpl.sh", "echo");

        fs.chmodSync(plain, 0o644);
        fs.chmodSync(script, 0o644);

        await compileOnce(project, {
            targets: [
                { entryPoint: plain, outputs: [{ destinationDir: project.at("out") }] },
                { entryPoint: script, outputs: [{ destinationDir: project.at("out") }] },
            ],
        });

        expect(fs.statSync(project.at("out", "notes.md")).mode & 0o111).toBe(0);
        expect(fs.statSync(project.at("out", "run.sh")).mode & 0o777).toBe(0o755);
    });

    /** An output written before its source became executable is made executable on the next build. */
    it("should make an unchanged output executable when its source becomes so", async () => {
        project = makeProject();
        const source = project.write("tool.tpl.py", "pass\n");
        const compilation = { targets: [{ entryPoint: source, outputs: [{ destinationDir: project.at("out") }] }] };

        fs.chmodSync(source, 0o644);
        await compileOnce(project, compilation);
        fs.chmodSync(source, 0o755);

        const { result } = await compileOnce(project, compilation);

        expect(result.outputs[0]!.action).toBe("unchanged");
        expect(fs.statSync(project.at("out", "tool.py")).mode & 0o777).toBe(0o755);
    });
});
