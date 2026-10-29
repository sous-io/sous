/** A stream the CLI writes to. */
export interface OutputStream {
    write(text: string): unknown;
    readonly isTTY?: boolean;
}

/** A stream the CLI reads answers from. */
export interface InputStream extends NodeJS.ReadableStream {
    readonly isTTY?: boolean;
}

/**
 * Where the CLI reads and writes. The plugin uses the process's own streams; tests pass their own.
 * Results go to standard output, and every message, error and prompt to standard error, so standard
 * output stays clean for pipes (about-cli-command-design, "Output and Errors").
 */
export interface CliIo {
    readonly stdout: OutputStream;
    readonly stderr: OutputStream;
    readonly stdin: InputStream;
    /** Sets the process's exit code; the CLI never calls `process.exit`. */
    setExitCode(code: number): void;
    /**
     * Stops the run the way Ctrl+C does (watch mode's Q key). Default: nothing; the process's own
     * streams send itself `SIGINT`, which stops watch mode.
     */
    interrupt?(): void;
}

/** The process's own streams. */
export function processIo(): CliIo {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        setExitCode(code) {
            process.exitCode = code;
        },
        interrupt() {
            process.kill(process.pid, "SIGINT");
        },
    };
}
