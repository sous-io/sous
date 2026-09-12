/**
 * References: how every sous command turns a word on the command line into the
 * one thing it names.
 *
 * Import from here rather than from the individual modules. `scopes.ts` says
 * what a reference can name, `find.ts` says what one means, and `pick.ts`
 * settles which meaning a run proceeds with.
 */

export * from "./scopes.js";
export * from "./find.js";
export * from "./pick.js";
