/**
 * `@sous-io/sous-lib-documents`: surgical editing of JSON, JSONC and YAML documents and the YAML frontmatter
 * of Markdown files, with every change expressed as primitive patches, and of plain text files as
 * lists of lines. An edit changes only what it names; every other byte stays. The config builder
 * is built on it.
 */
export type * from "./types.js";
export { parsePath, formatPath, isPathPrefix, pathsOverlap, PathSyntaxError } from "./path.js";
export { toPlainJson, deepEqual, compareValues, stableStringify, deepFreeze, getAtPath, isJsonObject, typeOfValue } from "./json.js";
export { applyPatch, applyPatches } from "./apply.js";
export { flattenPatchSet, isPatch, isPatchSet, countPatches, PatchRecorder, PATCH_OPS } from "./patch-set.js";
export { DocNode, type ItemPredicate } from "./node.js";
export { BaseDocument } from "./document.js";
export { ValueDocument, createDocument } from "./value-document.js";
export { TextDocument, parseDocument } from "./text-document.js";
export { splitFrontmatter, joinFrontmatter, type FrontmatterParts } from "./frontmatter.js";
export {
    LinesDocument,
    parseLines,
    managedBlockMarkers,
    HASH_COMMENTS,
    HTML_COMMENTS,
    SLASH_COMMENTS,
    CSS_COMMENTS,
    DASH_COMMENTS,
    SEMICOLON_COMMENTS,
    type CommentStyle,
    type LinePosition,
    type LinesOptions,
    type BlockMarkers,
} from "./lines.js";
export { formatForPath, commentStyleForPath, type FileFormat } from "./formats.js";
export { serializePatchSet, deserializePatchSet, parsePatch, parsePatchFile, PatchFormatError } from "./serialize.js";
export { describePatch, describePatchSet } from "./describe.js";
