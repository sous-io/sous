import { assert, expectExit, expectIncludes, parseJson } from "../lib/harness.mjs";

export default {
  name: "variables",
  title: "Variables: list, show, ask, answers files, env files, map",
  async run(t) {
    t.initializedProject({ dir: "vars" });
    // Subscribing asks every question at once, so the first answers go in with the command.
    const first = ["subscription", "add", "communication/agent-conduct", "--yes", "--no-build"];
    for (const a of ["pushOwnBranches=on-request", "openDraftPullRequests=on-request", "openPullRequests=on-request", "mergePullRequests=on-request", "releaseOrPublish=on-request", "createIssues=on-request", "commentOnIssuesAndPullRequests=on-request", "sendMessages=on-request"]) first.push("--answer", a);
    t.sous(first); // exits 1 on purpose: memoryRoot is still unanswered, but the subscription is written

    await t.step("vars list shows each variable as unanswered", () => {
      const r = expectExit(t.sous(["vars", "list"]));
      expectIncludes(r.stderr + r.stdout, "memoryRoot", "vars list");
      expectIncludes(r.stderr + r.stdout, "(unanswered)", "vars list");
    });

    await t.step("vars list --json holds the variables", () => {
      const j = parseJson(expectExit(t.sous(["--json", "vars", "list"])).stdout);
      assert.ok(JSON.stringify(j).includes("memoryRoot"));
    });

    await t.step("vars show <name> prints the question, the stored-as name and the env names it reads", () => {
      const r = expectExit(t.sous(["vars", "show", "pushOwnBranches"]));
      const text = r.stderr + r.stdout;
      expectIncludes(text, "SOUS_VAR_PUSH_OWN_BRANCHES", "vars show");
      expectIncludes(text, "recipe scope", "vars show");
    });

    await t.step("vars show of an unknown name fails and points at vars list", () => {
      const r = t.sous(["vars", "show", "nothing-here"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "vars list", "stderr");
    });

    await t.step("a non-interactive vars ask with unanswered variables fails naming --answer", () => {
      const r = t.sous(["vars", "ask", "--non-interactive"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "--answer", "stderr");
      expectIncludes(r.stderr, "SOUS_VAR_MEMORY_ROOT", "stderr");
    });

    await t.step("vars ask --dry-run writes nothing", () => {
      const before = t.read(".sous/.env");
      t.sous(["vars", "ask", "--dry-run", "--answer", "memoryRoot=.sous/memories"]);
      assert.equal(t.read(".sous/.env"), before);
    });

    await t.step("--answer stores the value in .sous/.env under its stored-as name", () => {
      const r = t.sous(["vars", "ask", "--non-interactive", "--var", "memoryRoot", "--answer", "memoryRoot=.sous/memories"]);
      assert.equal(r.code, 0, r.stderr);
      expectIncludes(t.read(".sous/.env"), "MEMORY_ROOT=.sous/memories", ".sous/.env");
    });

    await t.step("--answers-file (YAML) answers several variables", () => {
      t.write(
        "answers.yaml",
        [
          "pushOwnBranches: on-request",
          "openDraftPullRequests: on-request",
          "openPullRequests: on-request",
          "mergePullRequests: always",
          "releaseOrPublish: on-request",
        ].join("\n") + "\n",
      );
      const r = t.sous(["vars", "ask", "--non-interactive", "--answers-file", "answers.yaml", "--var", "pushOwnBranches", "--var", "openDraftPullRequests", "--var", "openPullRequests", "--var", "mergePullRequests", "--var", "releaseOrPublish"]);
      assert.equal(r.code, 0, r.stderr);
      const env = t.read(".sous/.env");
      expectIncludes(env, "SOUS_VAR_MERGE_PULL_REQUESTS=always", ".sous/.env");
    });

    await t.step("--answers-file (JSON) answers variables", () => {
      t.write("answers.json", JSON.stringify({ createIssues: "always", commentOnIssuesAndPullRequests: "on-request", sendMessages: "on-request" }));
      const r = t.sous(["vars", "ask", "--non-interactive", "--answers-file", "answers.json", "--var", "createIssues", "--var", "commentOnIssuesAndPullRequests", "--var", "sendMessages"]);
      assert.equal(r.code, 0, r.stderr);
      expectIncludes(t.read(".sous/.env"), "SOUS_VAR_CREATE_ISSUES=always", ".sous/.env");
    });

    await t.step("--env-file .sous/.env.local writes the answer to the machine-local file", () => {
      const r = t.sous(["vars", "ask", "--non-interactive", "--var", "sendMessages", "--answer", "sendMessages=always", "--env-file", ".sous/.env.local"]);
      assert.equal(r.code, 0, r.stderr);
      expectIncludes(t.read(".sous/.env.local"), "SOUS_VAR_SEND_MESSAGES=always", ".sous/.env.local");
    });

    await t.step("an --env-file that is not one of the two allowed files fails naming both", () => {
      const r = t.sous(["vars", "ask", "--non-interactive", "--var", "sendMessages", "--answer", "sendMessages=always", "--env-file", "other.env"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, ".sous/.env", "stderr");
      expectIncludes(r.stderr, ".sous/.env.local", "stderr");
    });

    await t.step("an answer from the shell environment shows up as its source", () => {
      const r = expectExit(t.sous(["vars", "show", "createIssues"], { env: { SOUS_VAR_CREATE_ISSUES: "on-request" } }));
      expectIncludes(r.stderr + r.stdout, "SOUS_VAR_CREATE_ISSUES", "vars show");
    });

    await t.step("a value outside an enum is rejected naming the variable", () => {
      const r = t.sous(["vars", "ask", "--non-interactive", "--var", "createIssues", "--answer", "createIssues=sometimes"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "createIssues", "stderr");
    });

    await t.step("vars map binds an environment variable to a recipe variable", () => {
      const r = t.sous(["vars", "map", "MY_MEMORY_DIR", "communication/agent-conduct/memoryRoot"]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(t.exists(".sous/conf.d/520-var-mappings.jsonc"));
      expectIncludes(t.read(".sous/conf.d/520-var-mappings.jsonc"), "MY_MEMORY_DIR", "mapping file");
      const shown = expectExit(t.sous(["vars", "show", "memoryRoot"], { env: { MY_MEMORY_DIR: "mapped/dir" } }));
      expectIncludes(shown.stderr + shown.stdout, "MY_MEMORY_DIR", "vars show");
    });

    await t.step("vars list --file reads definitions from a standalone file", () => {
      t.write(
        "questions.yaml",
        ["variables:", "  - name: apiUrl", "    type: url", "    prompt: Which API URL?", "    description: The base URL of the API the project talks to.", "    example: https://api.example.com", ""].join("\n"),
      );
      const r = t.sous(["vars", "list", "--file", "questions.yaml"]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      expectIncludes(r.stderr + r.stdout, "apiUrl", "vars list --file");
    });

    await t.step("the build now succeeds with every variable answered", () => {
      expectExit(t.sous(["build"], { env: { SOUS_VAR_SKILLS_ROOT: ".claude/skills" } }));
      assert.ok(t.exists("AGENTS.md"));
    });
  },
};
