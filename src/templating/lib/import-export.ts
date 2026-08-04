import { pathToFileURL } from "node:url";

/**
 * Dynamically import a single named export from a JavaScript/ESM file.
 *
 * Used to read declarative metadata (e.g. a script's `meta` export) at compile
 * time. Files are expected to have NO top-level side effects — importing them
 * runs module-level code.
 *
 * Failures are swallowed and reported as `undefined`: a file that fails to
 * import, or that lacks the requested export, simply yields no value rather
 * than aborting the whole template render. The optional `onError` callback
 * receives the path and error for diagnostics.
 *
 * @param absPath - Absolute path to the file to import.
 * @param exportName - The named export to read (e.g. "meta"). Use "default" for the default export.
 * @param onError - Optional callback invoked when import or lookup fails.
 * @returns The exported value, or undefined on any failure.
 */
export async function importNamedExport(
  absPath: string,
  exportName: string,
  onError?: (path: string, error: unknown) => void
): Promise<unknown> {
  try {
    const mod = await import(pathToFileURL(absPath).href);
    return mod[exportName];
  } catch (error) {
    onError?.(absPath, error);
    return undefined;
  }
}
