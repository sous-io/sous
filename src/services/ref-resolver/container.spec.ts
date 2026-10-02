import { describe, expect, it } from "vitest";
import { createRefContainer, getSharedRefContainer, sharedRefPicker, sharedRefResolver } from "./container.js";
import { REF_TOKENS } from "./tokens.js";
import { BaseRefSplitter, type PartialRef } from "./parser/partial-ref.js";
import { RefParser } from "./parser/ref-parser.js";
import { DroppedRef, RuleRefPruner, type RefPruneRule } from "./pruners/ref-pruner.js";
import { RefPickerService } from "./ref-picker-service.js";
import { RefResolverService } from "./ref-resolver-service.js";
import { makeInjectable } from "./injectable.js";
import { RefSource } from "./source.js";
import type { RefPruner } from "./pruners/ref-pruner.js";
import type { RefSplitter } from "./parser/partial-ref.js";

describe("createRefContainer()", () => {
  /**
   * The container should resolve every part: the parser, the resolver, the
   * picker, and every splitter, pruner and provider as a list.
   *
   * container.get(REF_TOKENS.Resolver) // -> a RefResolverService
   */
  it("should resolve every part of the ref services", () => {
    const container = createRefContainer();
    expect(container.get(REF_TOKENS.Parser)).toBeInstanceOf(RefParser);
    expect(container.get(REF_TOKENS.Resolver)).toBeInstanceOf(RefResolverService);
    expect(container.get(REF_TOKENS.Picker)).toBeInstanceOf(RefPickerService);
    expect(container.getAll<RefSplitter>(REF_TOKENS.Splitter)).toHaveLength(6);
    expect(container.getAll<RefPruner>(REF_TOKENS.Pruner).map((p) => p.source).sort()).toEqual(
      Object.values(RefSource).sort()
    );
    expect(container.getAll(REF_TOKENS.Provider).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Parts are shared within one container and separate between containers.
   *
   * container.get(Resolver) === container.get(Resolver); two containers differ
   */
  it("should share parts within a container and not between containers", () => {
    const one = createRefContainer();
    expect(one.get(REF_TOKENS.Resolver)).toBe(one.get(REF_TOKENS.Resolver));
    expect(createRefContainer().get(REF_TOKENS.Resolver)).not.toBe(one.get(REF_TOKENS.Resolver));
  });

  /**
   * A plugin adds a splitter by binding one more under the multi token.
   *
   * bind(Splitter).to(PluginSplitter); resolver.parse("plugin-form") // -> its ref
   */
  it("should accept one more splitter bound under the multi token", () => {
    class PluginSplitter extends BaseRefSplitter {
      readonly order = 450;
      protected read(state: PartialRef): PartialRef[] {
        if (state.rest !== "plugin-form") return [state];
        return [{ ...state, rest: "", ref: { kind: "envVar", name: "PLUGIN" } }];
      }
    }
    makeInjectable(PluginSplitter);

    const container = createRefContainer();
    container.bind(REF_TOKENS.Splitter).to(PluginSplitter);
    const resolver = container.get<RefResolverService>(REF_TOKENS.Resolver);
    expect(resolver.parse("plugin-form").refs).toContainEqual({ kind: "envVar", name: "PLUGIN" });
    expect(sharedRefResolver().parse("plugin-form").refs).not.toContainEqual({
      kind: "envVar",
      name: "PLUGIN",
    });
  });

  /**
   * A plugin adds a pruner the same way, and every pruner for a place is
   * applied in turn.
   *
   * bind(Pruner).to(NoGlobs) for the command line // a glob-free ref only
   */
  it("should accept one more pruner bound under the multi token", () => {
    class NoWorkflow extends RuleRefPruner {
      readonly source = RefSource.CommandLine;
      readonly place = "on the command line";
      protected rules(): RefPruneRule[] {
        return [
          {
            matches: (ref) => ref.kind === "namespace",
            action: "drop",
            message: "plugin says no namespaces",
          },
        ];
      }
    }
    makeInjectable(NoWorkflow);

    const container = createRefContainer();
    container.bind(REF_TOKENS.Pruner).to(NoWorkflow);
    const resolver = container.get<RefResolverService>(REF_TOKENS.Resolver);
    const result = resolver.parse("workflow");
    expect(result.refs.map((ref) => ref.kind)).not.toContain("namespace");
    expect(result.dropped[0]).toBeInstanceOf(DroppedRef);
  });
});

describe("shared instances", () => {
  /**
   * The shared resolver and picker come from one container, built once.
   *
   * sharedRefResolver() === sharedRefResolver()
   */
  it("should return the same instances every time", () => {
    expect(sharedRefResolver()).toBe(sharedRefResolver());
    expect(sharedRefPicker()).toBe(sharedRefPicker());
    expect(getSharedRefContainer()).toBe(getSharedRefContainer());
  });
});
