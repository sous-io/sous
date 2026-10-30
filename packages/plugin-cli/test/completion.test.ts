import { describe, expect, it } from "vitest";
import { namespacesPlugin, reposPlugin } from "./fixtures.js";
import { runCli } from "./helpers.js";

describe("shell completion", () => {
    /**
     * `sous completion <shell>` prints a script that calls the hidden `sous __complete`.
     *
     * sous completion bash   // -> "complete -o default -F _sous_complete sous"
     */
    it("should print a script for bash, zsh and fish", async () => {
        expect((await runCli([], ["completion", "bash"])).stdout).toContain("complete -o default -F _sous_complete sous");
        expect((await runCli([], ["completion", "zsh"])).stdout).toContain("compdef _sous_complete sous");
        expect((await runCli([], ["completion", "fish"])).stdout).toContain("complete -c sous -f -a '(_sous_complete)'");

        for (const shell of ["bash", "zsh", "fish"]) {
            expect((await runCli([], ["completion", shell])).stdout).toContain("sous __complete");
        }
    });

    /** An unknown shell is a usage error, exit code 2. */
    it("should refuse a shell it has no script for", async () => {
        const run = await runCli([], ["completion", "tcsh"]);

        expect(run.exitCode).toBe(2);
        expect(run.stderr).toContain("Error:");
    });

    /**
     * `sous __complete <words...>` lists the commands that may come next, one per line, leaving
     * out hidden ones and aliases.
     *
     * sous __complete repo ""   // -> "add\n..."
     */
    it("should list the subcommands that may come next", async () => {
        const root = await runCli([namespacesPlugin, reposPlugin], ["__complete", ""]);

        expect(root.stdout.split("\n")).toEqual(expect.arrayContaining(["namespace", "repo", "completion", "help"]));
        expect(root.stdout).not.toContain("__complete");
        expect(root.stdout).not.toMatch(/^ns$/m);

        const repo = await runCli([reposPlugin], ["__complete", "repo", "a"]);

        expect(repo.stdout).toBe("add\n");
        expect((await runCli([reposPlugin], ["__complete", "repo", ""])).stdout).not.toContain("secret");
    });

    /** A word starting with `-` completes the command's flags and the global flags. */
    it("should list flags for a word starting with a dash", async () => {
        const run = await runCli([reposPlugin], ["__complete", "repo", "add", "--"]);
        const words = run.stdout.split("\n");

        expect(words).toEqual(expect.arrayContaining(["--mode", "--yes", "--debug", "--help"]));
        expect((await runCli([reposPlugin], ["__complete", "repo", "add", "--mo"])).stdout).toBe("--mode\n");
    });
});
