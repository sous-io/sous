/**
 * Handlers: functions a plugin (or a recipe's manifest) provides for a purpose, such as checking
 * that a command is installed before a build. `sous.handlers.add(purpose, { id, handle })` adds one
 * from a plugin's `register()`. The `handler` entity kind, the helpers a handler receives and the
 * intents that run them belong to `@sous-io/sous-plugin-handlers`, which fills in
 * {@link SousHandlerTypes}.
 *
 * ```ts
 * sous.handlers.add("check", {
 *     id: "knowledge-worker/commands",
 *     handle: checkCommands,
 * });
 * ```
 */

/** Every purpose a handler can serve, in the order they are listed in the documentation. */
export const HANDLER_PURPOSES = ["check", "configure", "beforeBuild", "afterBuild", "uninstall", "migrate"] as const;

/** A purpose a handler serves. The set is fixed for now. */
export type HandlerPurpose = (typeof HANDLER_PURPOSES)[number];

/**
 * Filled in by `@sous-io/sous-plugin-handlers` through declaration merging:
 * `tools` is what a handler receives as `sous`, and `inputs` what each purpose passes second.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SousHandlerTypes {}

/** What a handler receives as its first argument (`sous`). */
export type HandlerToolsOf = SousHandlerTypes extends { tools: infer T } ? T : unknown;

/** What a handler of one purpose receives as its second argument. */
export type HandlerInputOf<P extends HandlerPurpose> = SousHandlerTypes extends { inputs: infer I }
    ? P extends keyof I
        ? I[P]
        : undefined
    : unknown;

/** A handler: the same function body works whether a manifest points at it or a plugin registers it. */
export type HandlerFunction<P extends HandlerPurpose = HandlerPurpose> = (sous: HandlerToolsOf, input: HandlerInputOf<P>) => unknown;

/** What `sous.handlers.add` takes. */
export interface HandlerRegistration<P extends HandlerPurpose = HandlerPurpose> {
    /** Names the handler in timings and reports: `knowledge-worker/commands`. Unique among handlers. */
    id: string;
    handle: HandlerFunction<P>;
    /** Moves it within its purpose: lower runs earlier. Default `500`. */
    order?: number;
}

/** `sous.handlers`. */
export interface HandlerRegistry {
    /** Adds a handler for a purpose, as a `handler` entity of this plugin. */
    add<const P extends HandlerPurpose>(purpose: P, definition: HandlerRegistration<P>): void;
}
