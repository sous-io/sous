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

describe("what a template can read about its output", () => {
    /** One source rendered to two outputs reads each output's own path and directory. */
    it("should give each output its own sousOutputPath and sousOutputDir", async () => {
        project = makeProject();
        const source = project.write("src/where.tpl.md", "{{ sousOutputPath }}|{{ sousOutputDir }}");

        const { result } = await compileOnce(project, {
            targets: [{ entryPoint: source, outputs: [{ destinationDir: project.at(".claude") }, { destinationFile: project.at(".codex", "AGENTS.md") }] }],
        });

        expect(result.ok).toBe(true);
        expect(project.read(".claude/where.md")).toBe(`${project.at(".claude", "where.md")}|${project.at(".claude")}`);
        expect(project.read(".codex/AGENTS.md")).toBe(`${project.at(".codex", "AGENTS.md")}|${project.at(".codex")}`);
    });

    /** A file included by another reads the path of the output it is included into. */
    it("should give an included file the path of the output it is included into", async () => {
        project = makeProject();
        project.write("src/part.tpl.md", "part for {{ sousOutputPath }}");
        const source = project.write("src/main.md", "@./part.tpl.md\n");

        const { result } = await compileOnce(project, { targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("out", "MAIN.md") }] }] });

        expect(result.ok).toBe(true);
        expect(project.read("out/MAIN.md")).toBe(`part for ${project.at("out", "MAIN.md")}\n`);
    });

    /** A transform that renames the file does not change what the template read: the path from before it. */
    it("should give the path from before a transform renames the file", async () => {
        project = makeProject();
        const source = project.write("src/a.tpl.md", "{{ sousOutputPath }}");
        const rename = {
            id: "rename",
            transform: (file: { source: string; destination: string; content: string }) => ({ ...file, destination: file.destination.replace("a.md", "b.md") }),
        };

        const { result } = await compileOnce(
            project,
            { targets: [{ entryPoint: source, outputs: [{ destinationDir: project.at("out"), transforms: ["rename"] }] }] },
            {},
            { register: (sous) => sous.entities.add("compilation-transform", rename) },
        );

        expect(result.ok).toBe(true);
        expect(project.read("out/b.md")).toBe(project.at("out", "a.md"));
    });

    /** `host.platform` is Node's platform, the value config expressions read. */
    it("should give templates host.platform", async () => {
        project = makeProject();
        const source = project.write("p.tpl.md", "{{ host.platform }}");

        await compileOnce(project, { targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("out.md") }] }] });

        expect(project.read("out.md")).toBe(process.platform);
    });

    /** `harness.id` is the output's harness, and empty for an output that belongs to none. */
    it("should give templates harness.id, empty when the output has no harness", async () => {
        project = makeProject();
        const source = project.write("h.tpl.md", '{% if harness.id == "claude-code" %}skill tool{% else %}plain words [{{ harness.id }}]{% endif %}');

        const { result } = await compileOnce(project, {
            targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("claude.md"), harness: "claude-code" }, { destinationFile: project.at("none.md") }] }],
        });

        expect(result.ok).toBe(true);
        expect(project.read("claude.md")).toBe("skill tool");
        expect(project.read("none.md")).toBe("plain words []");
    });

    /** A project variable named `host` wins over the one sous gives, so an existing template keeps working. */
    it("should let a project variable named host win", async () => {
        project = makeProject();
        const source = project.write("p.tpl.md", "{{ host }}");

        await compileOnce(project, { targets: [{ entryPoint: source, outputs: [{ destinationFile: project.at("out.md"), _vars: { host: "example.com" } }] }] });

        expect(project.read("out.md")).toBe("example.com");
    });
});
