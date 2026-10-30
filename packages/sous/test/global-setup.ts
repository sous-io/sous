import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
    export interface ProvidedContext {
        /** The bundled bin the tests run. */
        sousBin: string;
    }
}

/**
 * Builds what the bin tests run, once per test run: the compiled `@sous-io/plugin-api` (the bundle
 * keeps it outside) and the bundle itself. The bundle goes into a directory of its own under
 * `dist/`, so test runs side by side never overwrite each other's bin; it must stay inside this
 * package so `@sous-io/plugin-api` resolves from it.
 */
export default function setup(project: TestProject): () => void {
    const packageDir = path.resolve(import.meta.dirname, "..");
    const tsc = path.join(packageDir, "..", "..", "node_modules", "typescript", "bin", "tsc");
    const testDist = path.join(packageDir, "dist", "test");

    mkdirSync(testDist, { recursive: true });

    const dir = mkdtempSync(path.join(testDist, "run-"));
    const bin = path.join(dir, "bin.js");

    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: path.join(packageDir, "..", "plugin-api") });
    execFileSync(process.execPath, [path.join(packageDir, "scripts", "bundle.mjs"), bin]);
    project.provide("sousBin", bin);

    return () => rmSync(dir, { recursive: true, force: true });
}
