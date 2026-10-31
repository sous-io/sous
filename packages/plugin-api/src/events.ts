import type { Context } from "./context.js";
import type { BuiltConfig } from "./config.js";
import type { CoreEvents, IntentInput, IntentReturn, SousEvents, SousIntents } from "./registry.js";

/** What every event has. */
export interface EventBase {
    /** The event's name: `build.before`, `diagrams.rendered`. */
    readonly name: string;
    /** Shared with later listeners, and from an intent's `before` event to its `after` event. */
    readonly data: Map<string, unknown>;
    /** Stops the intent (or tells the emitter of a custom event to stop); the reason is reported. */
    cancel(reason: string): void;
    /** Whether a listener cancelled it. */
    readonly cancelled: boolean;
    /** The reason given to {@link cancel}. */
    readonly cancelReason: string | undefined;
    /** The plugin whose listener cancelled it. */
    readonly cancelledBy: string | undefined;
    /** Later listeners don't see this event. An intent still runs. */
    stopPropagation(): void;
    /** Whether a listener stopped propagation. */
    readonly propagationStopped: boolean;
}

/** A custom event, fired with `emit`. */
export interface CustomEvent<P = unknown> extends EventBase {
    readonly kind: "custom";
    payload: P;
}

/** `<intent>.before`: fired before the handler runs. Listeners may change `input`. */
export interface IntentBeforeEvent<I extends string = string, In = IntentInput<I>> extends EventBase {
    readonly kind: "before";
    readonly intent: I;
    input: In;
}

/** `<intent>.after`: fired after the handler returned. Listeners may replace `result`, its outputs. */
export interface IntentAfterEvent<I extends string = string, In = IntentInput<I>, R = IntentReturn<I>>
    extends EventBase {
    readonly kind: "after";
    readonly intent: I;
    readonly input: In;
    result: R;
}

/** `<intent>.error`: fired when the handler threw. A listener may turn the failure into outputs. */
export interface IntentErrorEvent<I extends string = string, In = IntentInput<I>, R = IntentReturn<I>>
    extends EventBase {
    readonly kind: "error";
    readonly intent: I;
    readonly input: In;
    readonly error: unknown;
    /** Turns the failure into these outputs; the intent then succeeds and `after` fires. */
    recover(result: R): void;
    /** Whether a listener recovered. */
    readonly recovered: boolean;
}

/** Any event, for regular expression listeners, which narrow by `event.name` or `event.kind`. */
export type AnyEvent = CustomEvent<unknown> | IntentBeforeEvent | IntentAfterEvent | IntentErrorEvent;

/** The payload of `config.built`. */
export interface ConfigBuiltPayload {
    /** The config that was just built. */
    config: BuiltConfig;
}

/** Every custom event TypeScript knows about. */
export type AllEvents = CoreEvents & SousEvents;

type KnownIntent = keyof SousIntents & string;

/** Every event name TypeScript knows about: custom events, and every intent's three events. */
export type KnownEventName = (keyof AllEvents & string) | `${KnownIntent}.${"before" | "after" | "error"}`;

type CustomOrAny<N extends string> = N extends keyof AllEvents ? CustomEvent<AllEvents[N]> : AnyEvent;

/**
 * The event object a listener for one exact name receives. An intent's three events are typed from
 * `SousIntents`; for an intent no plugin declared, the input and result are `unknown`.
 */
export type EventFor<N extends string> = N extends keyof AllEvents
    ? CustomEvent<AllEvents[N]>
    : N extends `${infer I}.before`
      ? I extends KnownIntent
          ? IntentBeforeEvent<I>
          : IntentBeforeEvent<I, unknown>
      : N extends `${infer I}.after`
        ? I extends KnownIntent
            ? IntentAfterEvent<I>
            : IntentAfterEvent<I, unknown, unknown>
        : N extends `${infer I}.error`
          ? I extends KnownIntent
              ? IntentErrorEvent<I>
              : IntentErrorEvent<I, unknown, unknown>
          : CustomOrAny<N>;

/** Turns a wildcard pattern into a template literal type: `build.*` becomes `build.${string}`. */
export type PatternTemplate<P extends string> = P extends `${infer A}*${infer B}` ? `${A}${string}${PatternTemplate<B>}` : P;

/** The event names a pattern matches, among those TypeScript knows. */
export type MatchingEventNames<P extends string> = Extract<KnownEventName, PatternTemplate<P>>;

/**
 * The event a listener receives for a pattern: an exact name gives that event, a wildcard the union
 * of every matching known event, and a regular expression {@link AnyEvent}.
 */
export type EventForPattern<P extends EventPattern> = P extends RegExp
    ? AnyEvent
    : P extends `${string}*${string}`
      ? [MatchingEventNames<P & string>] extends [never]
          ? AnyEvent
          : EventFor<MatchingEventNames<P & string>>
      : EventFor<P & string>;

/** What a listener subscribes to: an exact name, a wildcard (`build.*`, `*.before`) or a regular expression. */
export type EventPattern = string | RegExp;

/** A listener. It gets a `ctx` like a handler's, so it can run intents, read the config and report. */
export type Listener<E = AnyEvent> = (event: E, ctx: Context) => void | Promise<void>;

/** Options for `on` and `once`. */
export interface ListenerOptions {
    /** Higher runs first. Default `0`. */
    priority?: number;
}

/** The payload type of a custom event. */
export type EventPayload<N extends string> = N extends keyof AllEvents ? AllEvents[N] : unknown;
