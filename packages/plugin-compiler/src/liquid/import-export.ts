import { pathToFileURL } from "node:url";

/**
 * Imports one named export from a JavaScript module, for the `getFiles` tag's `import` attribute.
 * Files are expected to have no top-level side effects: importing them runs their code.
 *
 * A file that fails to import, or lacks the export, gives `undefined` rather than failing the
 * render; `onError` hears why.
 *
 * @param exportName - The export to read; `default` for the default export.
 */
export async function importNamedExport(
    absPath: string,
    exportName: string,
    onError?: (path: string, error: unknown) => void,
): Promise<unknown> {
    try {
        const mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;

        return mod[exportName];
    } catch (error) {
        onError?.(absPath, error);

        return undefined;
    }
}
