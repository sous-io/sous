/**
 * What every document shares: a root node, the record of every change made through it, and
 * applying patches made elsewhere.
 */
import { DocNode } from "./node.js";
import { parsePath } from "./path.js";
import { isPatchSet, PatchRecorder } from "./patch-set.js";
import type { DocumentBackend, JsonValue, Patch, PatchProblem, PatchSet, PathInput, PathSegment } from "./types.js";

/**
 * The base of the in-memory and text documents. A subclass reads values and applies one
 * primitive at a time; this class records every primitive in one patch set.
 */
export abstract class BaseDocument {
    private readonly recorder = new PatchRecorder("document");
    private readonly problemList: PatchProblem[] = [];
    private readonly backend: DocumentBackend;

    protected constructor() {
        this.backend = {
            read: (path) => this.readAt(path),
            emit: (patch) => this.record(patch),
            openSet: (name, path) => this.recorder.open(name, path),
            closeSet: () => this.recorder.close(),
        };
    }

    /** The whole document, as a node. */
    root(): DocNode {
        return new DocNode(this.backend, []);
    }

    /** A node at a path. */
    atPath(path: PathInput): DocNode {
        return new DocNode(this.backend, parsePath(path));
    }

    /** The document's current value. */
    abstract value(): JsonValue;

    /** Every change made so far, through nodes or {@link apply}, as one patch set. */
    patches(): PatchSet {
        return this.recorder.result();
    }

    /** Every patch that could not be applied so far. */
    problems(): PatchProblem[] {
        return [...this.problemList];
    }

    /**
     * Applies a patch or a whole patch set made elsewhere (a saved or previewed change), keeping
     * its sets. Returns the patches that could not be applied.
     */
    apply(patch: Patch | PatchSet): PatchProblem[] {
        const before = this.problemList.length;

        this.applyItem(patch);

        return this.problemList.slice(before);
    }

    /** The value at a path, with every change so far. */
    protected abstract readAt(path: readonly PathSegment[]): JsonValue | undefined;

    /** Applies one primitive; returns why it could not, or `undefined`. */
    protected abstract applyPrimitive(patch: Patch): PatchProblem | undefined;

    private applyItem(item: Patch | PatchSet): void {
        if (!isPatchSet(item)) {
            this.record(item);

            return;
        }

        this.recorder.open(item.name, item.path);

        try {
            for (const child of item.patches) {
                this.applyItem(child);
            }
        } finally {
            this.recorder.close();
        }
    }

    private record(patch: Patch): void {
        const problem = this.applyPrimitive(patch);

        if (problem !== undefined) {
            this.problemList.push(problem);
        }

        this.recorder.add(patch);
    }
}
