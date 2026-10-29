import { main } from "./main.js";

await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stderr: process.stderr,
    setExitCode(code) {
        process.exitCode = code;
    },
});
