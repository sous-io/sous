import path from "node:path";
import { fileURLToPath } from "node:url";
import { handOffToProjectInstall } from "./hand-off.js";
import { main } from "./main.js";

// A project that installs @sous-io/sous itself has pinned the version its templates and lockfile
// were written against, so that copy does the work: its bin is imported into this process and this
// one starts nothing (see hand-off.ts, and SOUS_NO_DELEGATE to keep the invoked copy running).
const argv = process.argv.slice(2);
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handedOff = await handOffToProjectInstall({ ownRoot, cwd: process.cwd(), env: process.env, argv, stderr: process.stderr });

if (!handedOff) {
    await main(argv, {
        cwd: process.cwd(),
        env: process.env,
        stderr: process.stderr,
        setExitCode(code) {
            process.exitCode = code;
        },
    });
}
