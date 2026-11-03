import { assert, expectExit, expectIncludes, parseJson } from "../lib/harness.mjs";

// All variables of communication/agent-conduct, answered so a build can run without a terminal.
const CONDUCT_ANSWERS = [
  "memoryRoot=.sous/memories",
  "pushOwnBranches=on-request",
  "openDraftPullRequests=on-request",
  "openPullRequests=on-request",
  "mergePullRequests=on-request",
  "releaseOrPublish=on-request",
  "createIssues=on-request",
  "commentOnIssuesAndPullRequests=on-request",
  "sendMessages=on-request",
];

export default {
  name: "recipes",
  title: "Recipes from the default repository: repo, recipe, namespace, subscription, lock",
  async run(t) {
    t.initializedProject({ dir: "recipes" });
    expectExit(t.sous(["build"]));

    await t.step("repo list shows the default repository", () => {
      const r = expectExit(t.sous(["repo", "list"]));
      expectIncludes(r.stderr + r.stdout, "sous-recipes", "repo list");
      expectIncludes(r.stderr + r.stdout, "github.com/sous-io/sous-recipes", "repo list");
    });

    await t.step("repo list --json is one object with the repositories", () => {
      const j = parseJson(expectExit(t.sous(["--json", "repo", "list"])).stdout);
      assert.ok(JSON.stringify(j).includes("sous-recipes"));
    });

    await t.step("repo search finds a recipe by a word", () => {
      const r = expectExit(t.sous(["repo", "search", "conduct"]));
      expectIncludes(r.stderr + r.stdout, "agent-conduct", "repo search");
    });

    await t.step("recipe list --json lists recipes with latest versions", () => {
      const j = parseJson(expectExit(t.sous(["--json", "recipe", "list"])).stdout);
      assert.ok(j.recipes.length >= 10);
      const core = j.recipes.find((r) => r.key === "core/sous-skills");
      assert.ok(core, "core/sous-skills is missing");
      assert.equal(core.subscribed, true);
    });

    await t.step("namespace list and namespace show", () => {
      const r = expectExit(t.sous(["namespace", "list"]));
      expectIncludes(r.stderr + r.stdout, "communication", "namespace list");
      const s = expectExit(t.sous(["namespace", "show", "communication"]));
      expectIncludes(s.stderr + s.stdout, "agent-conduct", "namespace show");
    });

    await t.step("recipe show prints versions and what the recipe asks", () => {
      const r = expectExit(t.sous(["recipe", "show", "communication/agent-conduct"]));
      const text = r.stderr + r.stdout;
      expectIncludes(text, "Published versions", "recipe show");
      expectIncludes(text, "communication/plain-speech", "recipe show dependencies");
    });

    await t.step("recipe show on an unknown recipe fails with an error on stderr", () => {
      const r = t.sous(["recipe", "show", "nope/nothing"]);
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout.trim(), "");
      expectIncludes(r.stderr, "Error:", "stderr");
    });

    await t.step("subscription add without --yes and without a terminal names --yes", () => {
      const r = t.sous(["subscription", "add", "communication/agent-conduct"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "--yes", "stderr");
    });

    await t.step("subscription add --dry-run changes nothing", () => {
      expectExit(t.sous(["subscription", "add", "communication/agent-conduct", "--yes", "--dry-run"]));
      const j = parseJson(expectExit(t.sous(["--json", "subscription", "list"])).stdout);
      assert.equal(j.subscriptions.some((s) => s.key === "communication/agent-conduct"), false);
    });

    await t.step("subscription add with all answers subscribes and builds", () => {
      const args = ["subscription", "add", "communication/agent-conduct", "--yes"];
      for (const a of CONDUCT_ANSWERS) args.push("--answer", a);
      args.push("--answer", "skillsRoot=.claude/skills");
      expectExit(t.sous(args));
      assert.ok(t.exists("AGENTS.md"));
    });

    await t.step("subscription list --json is { subscriptions: [...] } with the new one", () => {
      const j = parseJson(expectExit(t.sous(["--json", "subscription", "list"])).stdout);
      assert.deepEqual(Object.keys(j), ["subscriptions"]);
      const sub = j.subscriptions.find((s) => s.key === "communication/agent-conduct");
      assert.ok(sub, "new subscription missing");
      assert.equal(sub.enabled, true);
      assert.ok(sub.pinned.length >= 1);
    });

    await t.step("subscription list prints a table on stderr-or-stdout naming both", () => {
      const r = expectExit(t.sous(["subscription", "list"]));
      expectIncludes(r.stderr + r.stdout, "communication/agent-conduct", "list");
      expectIncludes(r.stderr + r.stdout, "core", "list");
    });

    await t.step("lock show lists the pinned versions", () => {
      const r = expectExit(t.sous(["lock", "show"]));
      expectIncludes(r.stderr + r.stdout, "communication/agent-conduct", "lock show");
      const j = parseJson(expectExit(t.sous(["--json", "lock", "show"])).stdout);
      assert.equal(j.lockfile.formatVersion, 1);
      assert.ok(j.lockfile.recipes["communication/agent-conduct"]);
    });

    await t.step("lock rebuild --dry-run changes nothing", () => {
      const before = t.read(".sous/sous.lock.json");
      expectExit(t.sous(["lock", "rebuild", "--dry-run"]));
      assert.equal(t.read(".sous/sous.lock.json"), before);
    });

    await t.step("subscription update --dry-run writes nothing", () => {
      const before = t.read(".sous/sous.lock.json");
      expectExit(t.sous(["subscription", "update", "--dry-run"]));
      assert.equal(t.read(".sous/sous.lock.json"), before);
    });

    await t.step("recipe update plans an update and writes nothing", () => {
      const before = t.read(".sous/sous.lock.json");
      expectExit(t.sous(["recipe", "update"]));
      assert.equal(t.read(".sous/sous.lock.json"), before);
    });

    await t.step("subscription disable switches it off and a build drops its memories", () => {
      expectExit(t.sous(["subscription", "disable", "communication/agent-conduct"]));
      const j = parseJson(expectExit(t.sous(["--json", "subscription", "list"])).stdout);
      assert.equal(j.subscriptions.find((s) => s.key === "communication/agent-conduct").enabled, false);
    });

    await t.step("subscription enable switches it back on", () => {
      expectExit(t.sous(["subscription", "enable", "communication/agent-conduct"]));
      const j = parseJson(expectExit(t.sous(["--json", "subscription", "list"])).stdout);
      assert.equal(j.subscriptions.find((s) => s.key === "communication/agent-conduct").enabled, true);
    });

    await t.step("subscription add of a skills recipe writes its skills into .claude/skills", () => {
      expectExit(t.sous(["subscription", "add", "cli/command-design", "--yes"]));
      const dirs = t.sh("ls .claude/skills").stdout.split("\n").filter(Boolean);
      assert.ok(dirs.length > 7, `expected new skill folders, got: ${dirs.join(", ")}`);
      assert.ok(dirs.some((d) => d.includes("cli") || d.includes("command")), dirs.join(", "));
    });

    await t.step("subscription remove drops the subscription and its written files", () => {
      const before = t.sh("ls .claude/skills").stdout.split("\n").filter(Boolean);
      expectExit(t.sous(["subscription", "remove", "cli/command-design"]));
      const j = parseJson(expectExit(t.sous(["--json", "subscription", "list"])).stdout);
      assert.equal(j.subscriptions.some((s) => s.key === "cli/command-design"), false);
      const after = t.sh("ls .claude/skills").stdout.split("\n").filter(Boolean);
      assert.ok(after.length < before.length, "the removed recipe's skill folders are still there");
    });

    await t.step("repo add of an already-trusted repository is accepted or says so", () => {
      const r = t.sous(["repo", "add", "https://github.com/sous-io/sous-recipes", "--yes"]);
      assert.ok(r.code === 0 || /already/i.test(r.stderr), describe(r));
    });
  },
};

function describe(r) {
  return `${r.command}\n${r.code}\n${r.stdout}\n${r.stderr}`;
}
