/**
 * What every document shares: a root node, the record of every change made through it, and
 * applying patches made elsewhere.
 */
import { DocNode } from "./node.js";
import { parsePath } from "./path.js";
import { isPatchSet, PatchRecorder } from "./patch-set.js";
import type { DocumentBackend, EntrySource, JsonValue, Patch, PatchProblem, PatchSet, PathInput, PathSegment, Placement } from "./types.js";

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
            reorder: (path, order, patches) => this.reorderEntries(path, order, patches),
            place: (path, key, value, placement, source, patches) => this.placeEntry(path, key, value, placement, source, patches),
            entrySource: (path) => this.entrySourceAt(path),
            valueSource: (path) => this.valueSourceAt(path),
            setFromSource: (patch, source) => this.setFromSource(patch, source),
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

    /**
     * Reorders the entries at a path in place (see `DocumentBackend.reorder`). A document with no
     * text has nothing to keep, so it returns `false` and the node applies the primitives.
     */
    protected reorderEntries(_path: readonly PathSegment[], _order: readonly number[], _patches: readonly Patch[]): boolean {
        return false;
    }

    /** Adds an entry at a placement (see `DocumentBackend.place`); `false` here, as for {@link reorderEntries}. */
    protected placeEntry(
        _path: readonly PathSegment[],
        _key: string | undefined,
        _value: JsonValue,
        _placement: Placement,
        _source: string | undefined,
        _patches: readonly Patch[],
    ): boolean {
        return false;
    }

    /** A key or item as written; a document with no text has none. */
    protected entrySourceAt(_path: readonly PathSegment[]): EntrySource | undefined {
        return undefined;
    }

    /** A value as written; a document with no text has none. */
    protected valueSourceAt(_path: readonly PathSegment[]): string | undefined {
        return undefined;
    }

    /** Replaces a value writing its source; `false` here, as for {@link reorderEntries}. */
    protected setFromSource(_patch: Patch, _source: string): boolean {
        return false;
    }

    /** Records primitives whose change a subclass made by other means, in the current patch set. */
    protected recordApplied(patches: readonly Patch[]): void {
        for (const patch of patches) {
            this.recorder.add(patch);
        }
    }

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
