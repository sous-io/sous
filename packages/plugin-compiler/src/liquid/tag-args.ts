/**
 * Splits a tag's raw `args` into an optional leading positional name and the remaining
 * `key="value"` markup. A leading identifier is the name only when no `=` follows it.
 *
 * ```ts
 * splitPositionalName('tasks root="x"');   // { name: "tasks", rest: 'root="x"' }
 * splitPositionalName('root="x"');         // { name: null, rest: 'root="x"' }
 * ```
 */
export function splitPositionalName(args: string): { name: string | null; rest: string } {
    const lead = args.match(/^\s*([a-zA-Z_][\w]*)(\s*=)?/);

    if (lead && !lead[2]) {
        return { name: lead[1]!, rest: args.slice(lead[0].length).trim() };
    }

    return { name: null, rest: args.trim() };
}
