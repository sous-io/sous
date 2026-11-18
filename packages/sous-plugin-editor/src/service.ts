/**
 * The `editor` service, for direct usage (spec 06): open a file, apply operations, get the changed
 * text, write it. It only edits. It keeps no record and undoes nothing by itself: a plugin that
 * edits directly is responsible for undoing what it did, with `undo` and the record `apply`
 * returned. Most plugins declare their edits instead (`editor.edits`), and Sous records and undoes
 * them.
 *
 * ```ts
 * const editor = ctx.services.get("editor");
 * const settings = editor.open("${projectRoot}/.claude/settings.json");
 *
 * settings.apply("ensureIncludes", { path: "permissions.allow", items: ["Bash(acme-commit.sh:*)"] });
 * settings.document.atPath("permissions.allow").get();   // read anything back
 * settings.text();                                       // the changed text
 * settings.write();                                      // writes only when it changed
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { getAtPath, parsePath, type JsonObject, type JsonValue } from "@sous-io/documents";
import { CHECKS, runCheck } from "./checks.js";
import { formatForFile, type EditableDocument, type EditorFormat } from "./documents-adapter.js";
import { createDirectories, removeEmptyDirectories } from "./apply.js";
import { operationInfo, resolveOperation } from "./operations.js";
import { FileSession } from "./session.js";
import type { EditorFile, EditorService, OperationInfo } from "./types.js";

/** Turns a written path into an absolute one: `${var}` substituted, `~` expanded, relative to the project root. */
export type PathResolver = (file: string) => string;

/** One file open for direct editing. */
class OpenFile implements EditorFile {
    private readonly session: FileSession;

    constructor(
        readonly path: string,
        readonly format: EditorFormat,
        private readonly original: string | undefined,
        private readonly resolve: PathResolver,
        private readonly countTokens: (text: string) => Promise<number>,
    ) {
        this.session = new FileSession(path || "(text)", format, original);
    }

    get existed(): boolean {
        return this.original !== undefined;
    }

    get document(): EditableDocument {
        return this.session.document();
    }

    apply(operation: string, params: JsonObject = {}): JsonValue {
        const step = resolveOperation(operation, params);

        if (step.definition.scope === "directory") {
            const created = createDirectories((step.params.paths as string[]).map((dir) => this.resolve(dir)), false);

            return { created };
        }

        return step.definition.up({ session: this.session, path: step.path, node: () => this.session.document().atPath(step.path) }, step.params, undefined);
    }

    undo(operation: string, params: JsonObject, record: JsonValue): void {
        const step = resolveOperation(operation, params);

        if (step.definition.scope === "directory") {
            const created = (record as { created?: string[] } | null)?.created ?? [];

            removeEmptyDirectories(created, false);

            return;
        }

        if (step.definition.scope === "file") {
            if ((record as { created?: boolean } | null)?.created === true) this.session.remove();

            return;
        }

        step.definition.down({ session: this.session, path: step.path, node: () => this.session.document().atPath(step.path) }, step.params, record);
    }

    check(check: string, arg: JsonValue, options: { path?: string; not?: boolean } = {}): Promise<boolean> {
        const session = this.session;
        const file = this.path;

        return runCheck(
            {
                file,
                fileExists: () => session.final() !== undefined,
                directoryExists: () => {
                    try {
                        return fs.statSync(file).isDirectory();
                    } catch {
                        return false;
                    }
                },
                parsed: () => session.final() !== undefined && session.parses(),
                value: (at) => getAtPath(session.document().value(), parsePath(at)),
                text: () => session.text(),
                tokens: () => this.countTokens(session.text()),
            },
            check,
            arg,
            options.path ?? "",
            options.not ?? false,
        );
    }

    text(): string {
        return this.session.text();
    }

    changed(): boolean {
        return this.session.changed();
    }

    write(): boolean {
        if (this.path === "") {
            throw new Error("This document was parsed from text, so it has no file to write; use text().");
        }

        if (!this.session.changed()) {
            return false;
        }

        const text = this.session.final();

        if (text === undefined) {
            fs.rmSync(this.path, { force: true });
        } else {
            fs.mkdirSync(path.dirname(this.path), { recursive: true });
            fs.writeFileSync(this.path, text, "utf8");
        }

        return true;
    }
}

/** The editor service. */
export class EditorServiceImpl implements EditorService {
    constructor(
        private readonly resolve: PathResolver,
        private readonly countTokens: (text: string) => Promise<number>,
    ) {}

    open(file: string, options: { format?: EditorFormat } = {}): EditorFile {
        const absolute = this.resolve(file);
        let text: string | undefined;

        try {
            text = fs.readFileSync(absolute, "utf8");
        } catch {
            text = undefined;
        }

        return new OpenFile(absolute, options.format ?? formatForFile(absolute), text, this.resolve, this.countTokens);
    }

    parse(text: string, format: EditorFormat): EditorFile {
        return new OpenFile("", format, text, this.resolve, this.countTokens);
    }

    formatOf(file: string): EditorFormat {
        return formatForFile(file);
    }

    operations(): OperationInfo[] {
        return operationInfo();
    }

    checks(): string[] {
        return [...CHECKS.keys()];
    }
}
