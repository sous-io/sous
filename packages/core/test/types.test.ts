import { describe, expectTypeOf, it } from "vitest";
import { IntentOutputs } from "@sous-io/plugin-api";
import type {
    AnyEvent,
    Context,
    CustomEvent,
    EntityType,
    EventFor,
    EventForPattern,
    IntentAfterEvent,
    IntentBeforeEvent,
    IntentErrorEvent,
    IntentInput,
    IntentResult,
    ServiceType,
    Sous,
} from "@sous-io/plugin-api";

interface Renderer {
    render(source: string): string;
}

interface RenderResult {
    file: string;
}

interface HarnessEntity {
    id: string;
    launch?: (args: string[]) => Promise<void>;
}

// What sous-plugin-diagrams/src/types.ts would declare.
declare module "@sous-io/plugin-api" {
    interface SousServices {
        "typed.renderer": Renderer;
    }

    interface SousIntents {
        "typed.render": { input: { only?: string }; result: { rendered: number } };
        "typed.clear": { input: Record<string, never>; result: void };
    }

    interface SousEvents {
        "typed.rendered": { files: RenderResult[] };
    }

    interface SousEntities {
        "typed-harness": HarnessEntity;
    }
}

describe("types across plugins", () => {
    /**
     * A plugin that imports another's types sees its services, intents, events and entities typed;
     * unknown names give `unknown`.
     */
    it("should type services, intents and entities from declaration merging", () => {
        expectTypeOf<ServiceType<"typed.renderer">>().toEqualTypeOf<Renderer>();
        expectTypeOf<ServiceType<"not.declared">>().toBeUnknown();
        expectTypeOf<IntentInput<"typed.render">>().toEqualTypeOf<{ only?: string }>();
        expectTypeOf<IntentResult<"typed.render">>().toEqualTypeOf<{ rendered: number }>();
        expectTypeOf<IntentResult<"not.declared">>().toBeUnknown();
        expectTypeOf<EntityType<"typed-harness">>().toEqualTypeOf<HarnessEntity>();
        expectTypeOf<EntityType<"config-key">["id"]>().toEqualTypeOf<string>();
        expectTypeOf<ReturnType<Context["services"]["get"]>>().toBeUnknown();
    });

    /**
     * An exact event name gives that event: an intent's before/after/error with its input and result,
     * or a custom event's payload.
     */
    it("should type exact event names", () => {
        expectTypeOf<EventFor<"typed.render.before">>().toEqualTypeOf<IntentBeforeEvent<"typed.render">>();
        expectTypeOf<EventFor<"typed.render.before">["input"]>().toEqualTypeOf<{ only?: string }>();
        expectTypeOf<EventFor<"typed.render.after">["result"]>().toEqualTypeOf<IntentOutputs<{ rendered: number }>>();
        expectTypeOf<EventFor<"typed.render.error">>().toEqualTypeOf<IntentErrorEvent<"typed.render">>();
        expectTypeOf<EventFor<"typed.rendered">>().toEqualTypeOf<CustomEvent<{ files: RenderResult[] }>>();
        expectTypeOf<EventFor<"undeclared.before">["input"]>().toBeUnknown();
        expectTypeOf<EventFor<"undeclared.thing">>().toEqualTypeOf<AnyEvent>();
    });

    /**
     * A wildcard listener gets the union of every matching known event; a regular expression gets
     * AnyEvent, narrowed by name.
     */
    it("should type wildcard and regex patterns", () => {
        expectTypeOf<EventForPattern<"typed.render.*">>().toEqualTypeOf<
            IntentBeforeEvent<"typed.render"> | IntentAfterEvent<"typed.render"> | IntentErrorEvent<"typed.render">
        >();
        expectTypeOf<EventForPattern<"*.rendered">>().toEqualTypeOf<CustomEvent<{ files: RenderResult[] }>>();
        expectTypeOf<EventForPattern<"nothing.*.matches">>().toEqualTypeOf<AnyEvent>();
        expectTypeOf<EventForPattern<RegExp>>().toEqualTypeOf<AnyEvent>();
    });

    /**
     * The `sous` object types listeners and service lookups from the same declarations.
     */
    it("should type the sous object", () => {
        const register = (sous: Sous) => {
            sous.on("typed.rendered", (event) => {
                expectTypeOf(event.payload.files).toEqualTypeOf<RenderResult[]>();
            });
            sous.on("typed.render.before", (event) => {
                expectTypeOf(event.input).toEqualTypeOf<{ only?: string }>();
            });
            expectTypeOf(sous.services.get("typed.renderer")).toEqualTypeOf<Renderer>();
            sous.intents.add({ intent: "typed.render", handle: (input) => IntentOutputs.of({ rendered: input.only ? 1 : 0 }) });
        };

        expectTypeOf(register).toBeFunction();
    });
});
