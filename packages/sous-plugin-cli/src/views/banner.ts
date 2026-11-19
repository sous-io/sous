import type { Style } from "./style.js";

const LOGO = ["  ▄█████ ▄████▄ ██  ██ ▄█████  ", "  ▀▀▀▄▄▄ ██  ██ ██  ██ ▀▀▀▄▄▄  ", "  █████▀ ▀████▀ ▀████▀ █████▀  "];

/**
 * The banner a command opens with on a terminal, as before the refactor (`header()` in today's
 * `src/utils/formatting.ts`). The CLI writes it to standard error, so standard output stays clean.
 */
export function renderBanner(style: Style): string {
    return [" ", " ", style.cyan(LOGO.join("\n")), "  Agent Configuration Manager         ", " ", ""].join("\n");
}
