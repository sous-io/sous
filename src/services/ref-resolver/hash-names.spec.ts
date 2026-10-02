import { describe, expect, it } from "vitest";
import { createRefContainer, sharedHashNames } from "./container.js";
import { HashNameRegistry, ProjectHashName, type HashName } from "./hash-names.js";
import { REF_TOKENS } from "./tokens.js";

/** A name a plugin might register. */
function named(name: string, registeredBy: string, bases: string[] = ["/x"]): HashName {
  return { name, registeredBy, description: "a test name.", bases: () => bases };
}

describe("ProjectHashName", () => {
  /**
   * `#project` stands for the project root, and for nothing when none is set.
   *
   * new ProjectHashName().bases({ projectRoot: "/p" }) // -> ["/p"]
   */
  it("should stand for the project root when the scope has one", () => {
    const project = new ProjectHashName();
    expect(project.bases({ projectRoot: "/p" })).toEqual(["/p"]);
    expect(project.bases({})).toEqual([]);
  });
});

describe("HashNameRegistry", () => {
  /**
   * A registered name can be read back and listed in order.
   *
   * register(b); register(a); list() // -> a, b
   */
  it("should list registered names sorted", () => {
    const registry = new HashNameRegistry([named("beta", "plugin-b"), named("alpha", "plugin-a")]);
    expect(registry.list().map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(registry.get("alpha")?.registeredBy).toBe("plugin-a");
    expect(registry.get("gamma")).toBeUndefined();
  });

  /**
   * A duplicate registration is an error naming both registrants.
   *
   * register("memories" by "sous"); register("memories" by "plugin-x") // throws
   */
  it("should refuse a duplicate registration naming both registrants", () => {
    const registry = new HashNameRegistry([named("memories", "sous")]);
    expect(() => registry.register(named("memories", "plugin-x"))).toThrow(
      /'#memories' is registered twice: by 'sous' and by 'plugin-x'/
    );
  });

  /** A name must be lowercase kebab-case. */
  it("should refuse an invalid name", () => {
    expect(() => new HashNameRegistry([named("Bad Name", "plugin")])).toThrow(/invalid/);
    expect(() => new HashNameRegistry([named("", "plugin")])).toThrow(/invalid/);
  });

  /**
   * The alias map holds `#name` for each name that has directories.
   *
   * aliasMap({}) // -> { "#a": ["/x"] } and nothing for a name with no bases
   */
  it("should build an alias map that leaves out a name with no directories", () => {
    const registry = new HashNameRegistry([named("a", "p"), named("empty", "p", [])]);
    expect(registry.aliasMap({})).toEqual({ "#a": ["/x"] });
  });
});

describe("the container's # names", () => {
  /**
   * The shared registry holds the built-in `#project`.
   *
   * sharedHashNames().get("project") // -> the built-in
   */
  it("should register #project in the shared registry", () => {
    expect(sharedHashNames().get("project")?.registeredBy).toBe("sous");
    expect(sharedHashNames().aliasMap({ projectRoot: "/p" })).toEqual({ "#project": ["/p"] });
  });

  /**
   * A plugin adds a name by binding one more under the HashName token, and a
   * second binding of an existing name fails when the registry is read.
   *
   * container.bind(HashName).toConstantValue(view); container.get(HashNames) // has it
   */
  it("should accept one more name and refuse a name bound twice", () => {
    const container = createRefContainer();
    container.bind(REF_TOKENS.HashName).toConstantValue(named("extras", "plugin"));
    const registry = container.get<HashNameRegistry>(REF_TOKENS.HashNames);
    expect(registry.list().map((entry) => entry.name)).toEqual(["extras", "memories", "project"]);

    const clash = createRefContainer();
    clash.bind(REF_TOKENS.HashName).toConstantValue(named("project", "plugin"));
    expect(() => clash.get(REF_TOKENS.HashNames)).toThrow(/registered twice/);
  });
});
