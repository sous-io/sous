/**
 * The self-update layer: which copies of sous are installed, which version
 * each should move to, and the package manager command that moves it.
 *
 * Import from here rather than from the individual modules. Nothing exported
 * here installs anything; `run.ts`, imported on its own by `sous update`, is
 * the flow that runs the commands the plans name.
 */

export * from "./versions.js";
export * from "./registry.js";
export * from "./managers.js";
export * from "./installs.js";
export * from "./plan.js";
