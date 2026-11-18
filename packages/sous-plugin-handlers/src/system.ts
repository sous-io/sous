/**
 * `handlers.system`: whether a command is installed, and its version. Finding a command on `PATH`
 * (with `PATHEXT` on Windows) is `host.processes.which`; this service only keeps each answer for
 * the run, so ten handlers asking about `git` look once.
 */

import type { Environment } from "@sous-io/sous-plugin-api";
import type { HostProcesses } from "@sous-io/sous-plugin-host/types";
import type { HandlersSystem } from "./types.js";

/** How long `<command> --version` may take before its version counts as unreadable. */
export const VERSION_TIMEOUT_MS = 5000;

/** A version number in a command's `--version` output: `2.43.0`, `1.7`, `20.11.1-rc.1`. */
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/;

/** The first version number in a command's output, or `undefined`. */
export function versionIn(text: string): string | undefined {
    return VERSION_PATTERN.exec(text)?.[0];
}

/** Makes `handlers.system` over `host.processes`, for one run. */
export function createHandlersSystem(processes: () => HostProcesses, env: Environment): HandlersSystem {
    const found = new Map<string, Promise<string | undefined>>();
    const versions = new Map<string, Promise<string | undefined>>();

    const locate = (name: string): Promise<string | undefined> => {
        let answer = found.get(name);

        if (answer === undefined) {
            answer = processes().which(name, env);
            found.set(name, answer);
        }

        return answer;
    };

    return {
        async isAppAvailable(name) {
            return (await locate(name)) !== undefined;
        },

        appVersion(name) {
            let answer = versions.get(name);

            if (answer === undefined) {
                answer = (async () => {
                    const file = await locate(name);

                    if (file === undefined) {
                        return undefined;
                    }

                    // A `.cmd` or `.bat` shim only starts through the shell on Windows.
                    const shim = /\.(cmd|bat)$/i.test(file);
                    const result = await processes().run(shim ? name : file, ["--version"], {
                        env,
                        timeoutMs: VERSION_TIMEOUT_MS,
                        label: `${name} --version`,
                        ...(shim ? { windowsShell: true } : {}),
                    });

                    if (result.timedOut) {
                        return undefined;
                    }

                    return versionIn(result.stdout) ?? versionIn(result.stderr);
                })();
                versions.set(name, answer);
            }

            return answer;
        },
    };
}
