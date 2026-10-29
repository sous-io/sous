import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PidFile, projectLabel } from "./pid.js";

/** Ported from src/test/integration/pid-service.test.ts. */
describe("PidFile", () => {
    const tmp = () => mkdtempSync(path.join(tmpdir(), "sous-pid-"));
    const projectAt = (root: string) => ({ root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") });

    describe("path()", () => {
        /**
         * With a project, the PID file is `<sousDir>/sous.pid`.
         *
         * new PidFile({ project: { sousDir: "/p/.sous" } }).path(); // -> "/p/.sous/sous.pid"
         */
        it("should return the sousDir-relative path when there is a project", () => {
            expect(new PidFile({ project: projectAt("/p"), cwd: "/elsewhere" }).path()).toBe("/p/.sous/sous.pid");
        });

        /**
         * `_vars.pidFilePath` wins over the default.
         *
         * new PidFile({ explicitPath: "/custom/w.pid", ... }).path(); // -> "/custom/w.pid"
         */
        it("should prefer an explicit pidFilePath var", () => {
            expect(new PidFile({ explicitPath: "/custom/w.pid", project: projectAt("/p"), cwd: "/x" }).path()).toBe("/custom/w.pid");
        });

        /**
         * With no project, the PID file sits in the working directory.
         *
         * new PidFile({ project: undefined, cwd: "/work" }).path(); // -> "/work/sous.pid"
         */
        it("should fall back to the working directory when there is no project", () => {
            expect(new PidFile({ project: undefined, cwd: "/work" }).path()).toBe("/work/sous.pid");
        });
    });

    describe("write() and read()", () => {
        /**
         * write() records this process's PID, creating missing directories; read() gives it back.
         *
         * pid.write(); pid.read(); // -> process.pid
         */
        it("should create the file with the current PID, making parent directories", () => {
            const root = tmp();
            const pid = new PidFile({ project: projectAt(path.join(root, "deep")), cwd: root });

            pid.write();

            expect(readFileSync(pid.path(), "utf8")).toBe(String(process.pid));
            expect(pid.read()).toBe(process.pid);
        });

        /**
         * read() gives `undefined` for a missing file or one that holds no number.
         *
         * pid.read(); // -> undefined
         */
        it("should read undefined for a missing or unreadable file", () => {
            const root = tmp();
            const pid = new PidFile({ project: projectAt(root), cwd: root });

            expect(pid.read()).toBeUndefined();
            writeFileSync(path.join(root, "x.pid"), "not a pid");
            expect(new PidFile({ explicitPath: path.join(root, "x.pid"), project: undefined, cwd: root }).read()).toBeUndefined();
        });
    });

    describe("isRunning()", () => {
        /**
         * A PID file of a live process means a watcher is running; a stale one does not.
         *
         * pid.write(12345); pid.isRunning(); // -> whatever isAlive(12345) says
         */
        it("should ask whether the recorded process is alive", () => {
            const root = tmp();
            let alive = true;
            const pid = new PidFile({ project: projectAt(root), cwd: root, isAlive: () => alive });

            expect(pid.isRunning()).toBe(false);
            pid.write(12345);
            expect(pid.isRunning()).toBe(true);
            alive = false;
            expect(pid.isRunning()).toBe(false);
        });

        /**
         * The default probe sees this very process as alive.
         *
         * pid.write(); pid.isRunning(); // -> true
         */
        it("should see the current process as running with the default probe", () => {
            const root = tmp();
            const pid = new PidFile({ project: projectAt(root), cwd: root });

            pid.write();
            expect(pid.isRunning()).toBe(true);
        });
    });

    describe("remove()", () => {
        /**
         * remove() deletes the file, and does nothing when there is none.
         *
         * pid.remove(); // the file is gone; a second call does not throw
         */
        it("should delete the file and not throw when it is missing", () => {
            const root = tmp();
            const pid = new PidFile({ project: projectAt(root), cwd: root });

            pid.write();
            pid.remove();
            expect(existsSync(pid.path())).toBe(false);
            expect(() => pid.remove()).not.toThrow();
        });
    });
});

describe("projectLabel()", () => {
    /**
     * The label is the project directory's name, or, with no project, the directory above `.sous`.
     *
     * projectLabel(undefined, "/code/acme/.sous/sous.pid"); // -> "acme"
     */
    it("should name the project directory, skipping .sous", () => {
        expect(projectLabel({ root: "/code/acme", sousDir: "/code/acme/.sous", configPath: undefined, confDir: "" }, "/x/y.pid")).toBe("acme");
        expect(projectLabel(undefined, "/code/acme/.sous/sous.pid")).toBe("acme");
        expect(projectLabel(undefined, "/code/other/w.pid")).toBe("other");
    });
});
