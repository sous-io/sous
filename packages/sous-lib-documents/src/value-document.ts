/**
 * A document held only in memory, as a plain JSON value.
 */
import { applyPatch } from "./apply.js";
import { BaseDocument } from "./document.js";
import { getAtPath, toPlainJson } from "./json.js";
import type { JsonValue, Patch, PatchProblem, PathSegment } from "./types.js";

/**
 * An in-memory document. Its value is never changed in place, so a value handed in (even a
 * frozen one) is safe.
 *
 * ```ts
 * const doc = createDocument({ tools: { codex: {} } });
 * doc.atPath("tools.codex").rename("openai");
 * doc.value();     // { tools: { openai: {} } }
 * doc.patches();   // { name: "document", patches: [{ op: "renameKey", path: "tools", key: "codex", to: "openai" }] }
 * ```
 */
export class ValueDocument extends BaseDocument {
    private current: JsonValue;

    constructor(value: JsonValue = {}) {
        super();
        this.current = value;
    }

    /** The current value. */
    value(): JsonValue {
        return this.current;
    }

    protected readAt(path: readonly PathSegment[]): JsonValue | undefined {
        return getAtPath(this.current, path);
    }

    protected applyPrimitive(patch: Patch): PatchProblem | undefined {
        let problem: PatchProblem | undefined;

        /* c8 ignore next: the root is never undefined here */
        this.current = applyPatch(this.current, patch, { onProblem: (found) => (problem = found) }) ?? {};

        return problem;
    }
}

/**
 * A new in-memory document, starting from a copy of a value (`{}` when none is given).
 */
export function createDocument(value?: unknown): ValueDocument {
    return new ValueDocument(value === undefined ? {} : (toPlainJson(value) ?? {}));
}
