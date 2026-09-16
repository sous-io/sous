/**
 * Types for project-install.mjs, which is plain JavaScript because it runs
 * before tsx is registered. Keep the two in step by hand.
 */

export const PACKAGE_NAME: "@sous-io/sous";
export const NO_DELEGATE_ENV: "SOUS_NO_DELEGATE";
export const DEBUG_ENV: "SOUS_DEBUG";
export const VERBOSE_FLAG: "--verbose";

export type ProjectInstall =
  | { same: true; root: string }
  | { same: false; root: string; version: string; bin: string };

export type HandoffPlan =
  | { kind: "run-self" }
  | { kind: "hand-off"; install: Extract<ProjectInstall, { same: false }>; notice: string[] };

export function isEnvFlagOn(value: string | undefined): boolean;
export function binEntryOf(pkg: unknown): string | undefined;
export function findProjectInstall(startDir: string, ownRoot: string): ProjectInstall | undefined;
export function formatHandoffNotice(input: {
  install: Extract<ProjectInstall, { same: false }>;
  ownVersion: string;
  ownRoot: string;
  verbose: boolean;
}): string[];
export function planHandoff(input: {
  cwd: string;
  ownRoot: string;
  env: Record<string, string | undefined>;
  argv?: readonly string[];
}): HandoffPlan;
export function handOffToProjectInstall(input: {
  ownRoot: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  stderr?: { write(chunk: string): unknown };
}): Promise<boolean>;
