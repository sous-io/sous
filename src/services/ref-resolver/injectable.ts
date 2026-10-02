/**
 * Marking a class as injectable without decorator syntax.
 *
 * sous runs TypeScript through tsx, and the published `bin/run.js` registers
 * tsx from the directory a command runs in, so the `experimentalDecorators`
 * flag in this repository's tsconfig does not reach it; esbuild also emits no
 * decorator metadata. Inversify's decorators are plain functions, though, so
 * calling them here marks every constructor parameter with its token
 * explicitly and needs neither a compiler flag nor `reflect-metadata`.
 */

import { decorate, inject, injectable, multiInject } from "inversify";

/** One constructor parameter: a token bound once, or a token bound many times. */
export type ConstructorParameter = symbol | { multi: symbol };

/**
 * Marks a class injectable and names the token of every constructor parameter,
 * in order.
 *
 * makeInjectable(RefParser, [{ multi: REF_TOKENS.Splitter }]);
 *
 * @param target - The class.
 * @param parameters - The token of each constructor parameter, in order.
 */
export function makeInjectable(
  target: new (...args: never[]) => unknown,
  parameters: ConstructorParameter[] = []
): void {
  decorate(injectable(), target);
  parameters.forEach((parameter, index) => {
    const decorator =
      typeof parameter === "symbol" ? inject(parameter) : multiInject(parameter.multi);
    decorate(decorator, target, index);
  });
}
