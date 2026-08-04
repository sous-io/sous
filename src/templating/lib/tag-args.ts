/**
 * Split a tag's raw `args` string into an optional leading positional
 * identifier and the remaining `key="value"` hash markup.
 *
 * A leading identifier is treated as the positional name ONLY when it is not
 * immediately followed by `=` — so `getFiles tasks root="x"` yields
 * `{ name: "tasks", rest: 'root="x"' }`, while `getFiles root="x"` yields
 * `{ name: null, rest: 'root="x"' }` (the first token is the `root` attribute).
 *
 * @param args - The raw `TagToken.args` string.
 * @returns The positional name (or null) and the remaining hash markup.
 */
export function splitPositionalName(args: string): { name: string | null; rest: string } {
  const lead = args.match(/^\s*([a-zA-Z_][\w]*)(\s*=)?/);
  if (lead && !lead[2]) {
    return { name: lead[1], rest: args.slice(lead[0].length).trim() };
  }
  return { name: null, rest: args.trim() };
}
