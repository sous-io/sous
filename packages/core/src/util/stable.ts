/**
 * A stable text key for any value: object keys sorted, so equal inputs give equal keys. Used to find
 * an intent called again with the same input.
 */
export function stableKey(value: unknown): string {
    if (value === undefined) {
        return "undefined";
    }

    try {
        return JSON.stringify(sortKeys(value)) ?? "undefined";
    } catch {
        return "[unserializable]";
    }
}

function sortKeys(value: unknown, seen = new WeakSet<object>()): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sortKeys(item, seen));
    }

    if (value !== null && typeof value === "object") {
        if (seen.has(value)) {
            return "[circular]";
        }

        seen.add(value);

        const out: Record<string, unknown> = {};

        for (const key of Object.keys(value).sort()) {
            out[key] = sortKeys((value as Record<string, unknown>)[key], seen);
        }

        return out;
    }

    return value;
}
