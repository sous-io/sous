/**
 * One file while it is edited: its text as it was read, its text now, and the document over it,
 * opened when a structured operation first needs it. A text operation (a line, a block) works on
 * the text; a structured one on the document. Switching between them keeps every edit.
 */

import { openDocument, type EditableDocument, type EditorFormat } from "./documents-adapter.js";

/** A file Sous cannot parse, or a format it cannot edit. Its edits are skipped, never failed. */
export class UnparseableFileError extends Error {
    constructor(readonly file: string, cause: unknown) {
        super(`Sous cannot parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = "UnparseableFileError";
    }
}

/** One file being edited. */
export class FileSession {
    private current: string | undefined;
    private doc: EditableDocument | undefined;

    /**
     * @param file - The file, absolute (used in messages).
     * @param format - Its format.
     * @param original - Its text as read, or `undefined` when it does not exist.
     */
    constructor(
        readonly file: string,
        readonly format: EditorFormat,
        readonly original: string | undefined,
    ) {
        this.current = original;
    }

    /** Whether the file exists now (an edit to a missing file creates it). */
    exists(): boolean {
        return this.doc !== undefined || this.current !== undefined;
    }

    /**
     * The document, opened from the text now (an empty document for a missing file, which the
     * first edit creates).
     *
     * @throws UnparseableFileError when the text cannot be parsed or the format cannot be edited.
     */
    document(): EditableDocument {
        if (this.doc === undefined) {
            try {
                this.doc = openDocument(this.current ?? "", this.format);
            } catch (error) {
                throw new UnparseableFileError(this.file, error);
            }
        }

        return this.doc;
    }

    /** Checks the file can be parsed, opening the document. */
    parses(): boolean {
        try {
            this.document();

            return true;
        } catch {
            return false;
        }
    }

    /** The text now: `""` for a missing file. */
    text(): string {
        return this.final() ?? "";
    }

    /** Replaces the text, closing the document (it reopens from this text when next needed). */
    setText(text: string): void {
        this.doc = undefined;
        this.current = text;
    }

    /** Removes the file (a rollback of a file Sous created). */
    remove(): void {
        this.doc = undefined;
        this.current = undefined;
    }

    /**
     * The text to write, or `undefined` when the file should not exist. A missing file that was
     * opened but never changed stays missing.
     */
    final(): string | undefined {
        if (this.doc !== undefined) {
            const text = this.doc.toString();

            if (this.current === undefined && text === "" ) {
                return undefined;
            }

            if (this.current === undefined && this.isEmptyDocument()) {
                return undefined;
            }

            this.current = text;
        }

        return this.current;
    }

    /** Whether the text differs from what was read (a file created or removed counts). */
    changed(): boolean {
        return this.final() !== this.original;
    }

    private isEmptyDocument(): boolean {
        const value = this.doc!.value();

        return value === null || (typeof value === "object" && Object.keys(value).length === 0);
    }
}
