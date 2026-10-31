/**
 * Tells Node that a sous config file written as an ES module is one, so Node does not print
 * MODULE_TYPELESS_PACKAGE_JSON ("Module type of file is not specified and it doesn't parse as
 * CommonJS") for every run in a project whose package.json has no "type".
 *
 * Node guesses the format of such a `.js` file by trying CommonJS first and falling back to ES
 * module. This does the same guess, and when it lands on ES module it says so in a `module.registerHooks`
 * load hook (synchronous, Node 22.15 and later), so the warning has nothing to report. A file Node would
 * read as CommonJS is left to Node. On a Node without `registerHooks` nothing is registered and Node
 * behaves as it always did.
 */

import fs from "node:fs";
import module from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** The `.js` config files (as file URLs without a query) the hook may treat as ES modules. */
const registered = new Set<string>();

let hooked = false;

/** True when the source parses as a CommonJS module body (Node tries this first). */
function parsesAsCommonJs(source: string): boolean {
    try {
        new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`);

        return true;
    } catch {
        return false;
    }
}

/** True for a source that only parses as an ES module (import, export, import.meta, top-level await). */
export function isEsModuleSource(source: string): boolean {
    return !parsesAsCommonJs(source);
}

/**
 * Marks a `.js` config file so Node loads it as an ES module when it is written as one. Registers the
 * hook the first time it is called. Does nothing for other extensions or when the Node has no `registerHooks`.
 */
export function declareConfigModule(file: string, url: string): void {
    const hooks = (module as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;

    if (typeof hooks !== "function" || !file.endsWith(".js")) {
        return;
    }

    registered.add(url.split("?")[0] as string);

    if (hooked) {
        return;
    }

    hooked = true;
    hooks({
        load(
            loadUrl: string,
            context: { format?: string | null },
            nextLoad: (url: string, context: unknown) => { format?: string | null; source?: string | Buffer | Uint8Array },
        ) {
            if (!registered.has(loadUrl.split("?")[0] as string) || (context.format !== undefined && context.format !== null)) {
                return nextLoad(loadUrl, context);
            }

            let source: string;

            try {
                source = fs.readFileSync(fileURLToPath(loadUrl.split("?")[0] as string), "utf8");
            } catch {
                return nextLoad(loadUrl, context);
            }

            return nextLoad(loadUrl, isEsModuleSource(source) ? { ...context, format: "module" } : context);
        },
    });
}
