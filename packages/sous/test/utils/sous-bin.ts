import { inject } from "vitest";

/** The bundled bin under test, built once per run by `test/global-setup.ts`. */
export const binPath: string = inject("sousBin");
