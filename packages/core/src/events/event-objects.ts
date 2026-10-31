import type { EventBase } from "@sous-io/plugin-api";

/**
 * The event objects listeners receive. One class per kind; each shares {@link BaseEvent}'s
 * cancelling, propagation and data.
 */
export abstract class BaseEvent implements EventBase {
    readonly data: Map<string, unknown>;
    cancelled = false;
    cancelReason: string | undefined = undefined;
    cancelledBy: string | undefined = undefined;
    propagationStopped = false;

    /** The plugin whose listener is running now, so a cancel names it. */
    currentPlugin: string | undefined = undefined;

    constructor(
        readonly name: string,
        data?: Map<string, unknown>,
    ) {
        this.data = data ?? new Map();
    }

    cancel(reason: string): void {
        if (!this.cancelled) {
            this.cancelled = true;
            this.cancelReason = reason;
            this.cancelledBy = this.currentPlugin;
        }
    }

    stopPropagation(): void {
        this.propagationStopped = true;
    }
}

/** A custom event. */
export class CustomEventImpl<P = unknown> extends BaseEvent {
    readonly kind = "custom" as const;

    constructor(
        name: string,
        public payload: P,
    ) {
        super(name);
    }
}

/** `<intent>.before`. */
export class BeforeEventImpl<In = unknown> extends BaseEvent {
    readonly kind = "before" as const;

    constructor(
        readonly intent: string,
        public input: In,
        data: Map<string, unknown>,
    ) {
        super(`${intent}.before`, data);
    }
}

/** `<intent>.after`. */
export class AfterEventImpl<In = unknown, R = unknown> extends BaseEvent {
    readonly kind = "after" as const;

    constructor(
        readonly intent: string,
        readonly input: In,
        public result: R,
        data: Map<string, unknown>,
    ) {
        super(`${intent}.after`, data);
    }
}

/** `<intent>.error`. */
export class ErrorEventImpl<In = unknown, R = unknown> extends BaseEvent {
    readonly kind = "error" as const;
    recovered = false;
    recoveredResult: R | undefined = undefined;

    constructor(
        readonly intent: string,
        readonly input: In,
        readonly error: unknown,
        data: Map<string, unknown>,
    ) {
        super(`${intent}.error`, data);
    }

    recover(result: R): void {
        this.recovered = true;
        this.recoveredResult = result;
    }
}
