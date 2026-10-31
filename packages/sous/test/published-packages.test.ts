import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The repository's packages directory. */
const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every package that is published to npm: those not marked private. */
function publishedPackages(): Array<{ dir: string; json: { name: string; private?: boolean; repository?: { url?: string; directory?: string } } }> {
    return fs
        .readdirSync(PACKAGES, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(PACKAGES, entry.name, "package.json")))
        .map((entry) => ({ dir: entry.name, json: JSON.parse(fs.readFileSync(path.join(PACKAGES, entry.name, "package.json"), "utf8")) }))
        .filter((pkg) => pkg.json.private !== true);
}

describe("published packages", () => {
    /**
     * npm's trusted publishing checks a package's `repository.url` against the repository the
     * release runs in, and refuses the publish when they differ, so a package without one fails
     * only at release time.
     */
    it("should each name this repository and its own directory", () => {
        const published = publishedPackages();

        expect(published.map((pkg) => pkg.json.name).sort()).toEqual(["@sous-io/plugin-api", "@sous-io/sous"]);

        for (const pkg of published) {
            expect(pkg.json.repository?.url, pkg.json.name).toBe("git+https://github.com/sous-io/sous.git");
            expect(pkg.json.repository?.directory, pkg.json.name).toBe(`packages/${pkg.dir}`);
        }
    });
});
