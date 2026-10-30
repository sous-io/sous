/**
 * `@sous-io/documents`: surgical editing of JSON, JSONC and YAML documents, keeping comments, key
 * order and formatting, with every change expressed as primitive patches. The config builder is built on it.
 */
export type * from "./types.js";
export { parsePath, formatPath, isPathPrefix, pathsOverlap, PathSyntaxError } from "./path.js";
export { toPlainJson, deepEqual, stableStringify, deepFreeze, getAtPath, isJsonObject, typeOfValue } from "./json.js";
export { applyPatch, applyPatches } from "./apply.js";
export { flattenPatchSet, isPatch, isPatchSet, countPatches, PatchRecorder, PATCH_OPS } from "./patch-set.js";
export { DocNode, type ItemPredicate } from "./node.js";
export { BaseDocument } from "./document.js";
export { ValueDocument, createDocument } from "./value-document.js";
export { TextDocument, parseDocument } from "./text-document.js";
export { serializePatchSet, deserializePatchSet, parsePatch, parsePatchFile, PatchFormatError } from "./serialize.js";
export { describePatch, describePatchSet } from "./describe.js";
