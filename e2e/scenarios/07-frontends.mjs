import fs from "node:fs";
import path from "node:path";
import { assert, expectExit, expectIncludes, parseJson, run } from "../lib/harness.mjs";

const MCP_CLIENT = `
import { Client } from "/opt/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/opt/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const transport = new StdioClientTransport({ command: "sous", args: ["mcp"], env: { ...process.env }, cwd: process.cwd() });
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);
const out = { server: client.getServerVersion(), capabilities: client.getServerCapabilities() };
const listed = await client.listTools();
out.tools = listed.tools.map((tool) => ({ name: tool.name, description: tool.description, hasSchema: !!tool.inputSchema }));
const target = listed.tools.find((tool) => /config.?show/i.test(tool.name));
if (target) {
  const result = await client.callTool({ name: target.name, arguments: {} });
  out.called = target.name;
  out.isError = result.isError ?? false;
  out.structured = result.structuredContent ?? null;
  out.text = (result.content ?? []).map((c) => c.text ?? "").join("\\n").slice(0, 300);
}
const bad = listed.tools.find((tool) => /config.?get/i.test(tool.name));
if (bad) {
  const result = await client.callTool({ name: bad.name, arguments: { path: "no.such.path" } });
  out.missingPathIsError = result.isError ?? false;
}
console.log(JSON.stringify(out));
await client.close();
`;

export default {
  name: "frontends",
  title: "Front ends: sous mcp over stdio, sous launch and harness run-headless with a fake claude",
  async run(t) {
    const project = t.initializedProject({ dir: "front" });
    expectExit(t.sous(["build"], { cwd: project }));

    let mcp;
    await t.step("sous mcp answers initialize, lists tools and runs a read-only tool", () => {
      const file = t.write("mcp-client.mjs", MCP_CLIENT, t.root);
      const r = run("node", [file], { cwd: project, env: { ...t.env }, timeout: 120_000 });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      mcp = parseJson(r.stdout.trim().split("\n").pop(), "mcp client output");
      assert.ok(mcp.server?.name, "no server name");
      assert.ok(mcp.tools.length >= 10, `only ${mcp.tools.length} tools`);
      assert.ok(mcp.tools.every((tool) => tool.hasSchema), "a tool has no input schema");
      assert.ok(mcp.called, `no config show tool among: ${mcp.tools.map((x) => x.name).join(", ")}`);
      assert.equal(mcp.isError, false);
    });

    await t.step("the MCP tool result carries structured content with the built config", () => {
      assert.ok(mcp?.structured, `no structuredContent; text was: ${mcp?.text}`);
      assert.ok(JSON.stringify(mcp.structured).includes("sous-recipes"));
    });

    await t.step("an MCP tool that fails reports isError instead of crashing the server", () => {
      assert.equal(mcp?.missingPathIsError, true);
    });

    // A fake claude: records its arguments and prints what Claude Code prints in stream-json mode.
    const bin = path.join(t.root, "fakebin");
    const argsLog = path.join(t.root, "claude-args.log");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argsLog}"
pwd > "${argsLog}.cwd"
if [[ ! -t 0 ]]; then cat > "${argsLog}.stdin"; else : > "${argsLog}.stdin"; fi
if [[ " $* " == *" -p "* || " $* " == *" --print "* ]]; then
  echo '{"type":"system","subtype":"init","session_id":"e2e-session"}'
  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"fake answer"}]},"session_id":"e2e-session"}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"fake answer","session_id":"e2e-session"}'
fi
exit 0
`,
      { mode: 0o755 },
    );
    const withFake = { PATH: `${bin}:${process.env.PATH}` };

    await t.step("sous launch claude builds, then starts claude with the arguments after --", () => {
      const r = t.sous(["launch", "claude", "--", "--e2e-flag", "value"], { cwd: project, env: withFake });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const args = fs.readFileSync(argsLog, "utf8");
      expectIncludes(args, "--e2e-flag", "claude args");
      expectIncludes(args, "value", "claude args");
      assert.equal(fs.readFileSync(`${argsLog}.cwd`, "utf8").trim(), project);
    });

    await t.step("sous launch --no-build skips the build", () => {
      t.sh("rm -f AGENTS.md", { cwd: project });
      const r = t.sous(["launch", "claude", "--no-build"], { cwd: project, env: withFake });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(t.exists("AGENTS.md", project), false);
    });

    await t.step("sous launch with a build first rewrites missing outputs", () => {
      expectExit(t.sous(["launch", "claude"], { cwd: project, env: withFake }));
      assert.ok(t.exists("AGENTS.md", project));
    });

    await t.step("sous launch of a tool that is not installed fails naming it", () => {
      const r = t.sous(["launch", "no-such-agent-tool", "--no-build"], { cwd: project, env: withFake });
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "no-such-agent-tool", "stderr");
    });

    await t.step("harness run-headless passes the prompt to claude in print mode", () => {
      const r = t.sous(["harness", "run-headless", "--prompt", "say hi", "--transcript"], { cwd: project, env: withFake });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const args = fs.readFileSync(argsLog, "utf8");
      const stdin = fs.readFileSync(`${argsLog}.stdin`, "utf8");
      assert.ok((args + stdin).includes("say hi"), `the prompt reached claude neither as an argument nor on stdin:\n${args}\n--stdin--\n${stdin}`);
      expectIncludes(args, "stream-json", "claude args");
    });

    await t.step("harness run-headless --json reports the transcript's answer", () => {
      const r = t.sous(["--json", "harness", "run-headless", "--prompt", "say hi", "--transcript"], { cwd: project, env: withFake });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const j = parseJson(r.stdout);
      assert.ok(JSON.stringify(j).includes("fake answer"), r.stdout);
    });

    await t.step("harness run-headless without --prompt fails naming the flag", () => {
      const r = t.sous(["harness", "run-headless"], { cwd: project, env: withFake });
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "prompt", "stderr");
    });

    await t.step("harness run-headless with a real Claude account is not exercised", () => {
      t.skip("needs a real, signed-in Claude account; the fake claude above checks the arguments sous passes");
    });
  },
};
