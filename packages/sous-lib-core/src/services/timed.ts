import type { Timer } from "../timing/timer.js";

/**
 * Times every method call on a service object: a proxy whose methods are timed and bound to
 * the real object, so private fields and `this` keep working. Functions are timed directly;
 * anything else is returned as it is.
 */
export function timeService<T>(service: T, name: string, plugin: string, timer: Timer): T {
    if (typeof service === "function") {
        return timeFunction(service as (...args: unknown[]) => unknown, undefined, name, plugin, timer) as T;
    }

    if (service === null || typeof service !== "object") {
        return service;
    }

    const bound = new Map<PropertyKey, unknown>();

    return new Proxy(service as object, {
        get(target, property) {
            const value = Reflect.get(target, property, target);

            if (typeof value !== "function" || property === "constructor") {
                return value;
            }

            let timed = bound.get(property);

            if (timed === undefined) {
                timed = timeFunction(value as (...args: unknown[]) => unknown, target, `${name}.${String(property)}`, plugin, timer);
                bound.set(property, timed);
            }

            return timed;
        },
    }) as T;
}

/** A function that times each call of `fn` under `service.method`. */
export function timeFunction(
    fn: (...args: unknown[]) => unknown,
    self: unknown,
    key: string,
    plugin: string,
    timer: Timer,
    category: "service.method" | "entity.method" = "service.method",
): (...args: unknown[]) => unknown {
    return function timedCall(this: unknown, ...args: unknown[]) {
        return timer.measure(category, key, plugin, () => fn.apply(self ?? this, args));
    };
}
