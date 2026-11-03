/**
 * The contract of plugin-web: the `web.*` intents the editor runs over its socket. Each returns
 * one object (a list comes wrapped), whose shape the browser reads in web/src/lib/api.ts. They are
 * `internal`: the CLI and agents have the owners' own intents for the same facts.
 *
 * Other plugins import this file type-only.
 */
import type { RegionSegment, RenderedRegion } from "@sous-io/plugin-liquid/types";

export type FileOrigin =
    | { kind: "project" }
    | {
          kind: "recipe";
          host: string;
          owner: string;
          repo: string;
          namespace: string;
          recipe: string;
          version: string;
          /** The path inside the recipe's directory. */
          recipePath: string;
          /** Where sous read it: the store, a linked checkout, the project. */
          source: string;
      }
    | { kind: "external" }
    /** A target a plugin wrote as text (CLAUDE.md built from memories), not a file. */
    | { kind: "generated" }
    | { kind: "sample" };

export interface WebFile {
    /** Stays the same for a path across rebuilds. */
    id: string;
    /** Absolute. */
    path: string;
    /** For people: relative to the project, or `namespace/recipe/path` for a recipe file. */
    display: string;
    origin: FileOrigin;
    isTpl: boolean;
    /** `entry` files are a target's sources; `partial` files are only included. */
    role: "entry" | "partial";
    /** The outputs it is the source of, relative to the project. */
    outputs: string[];
}

export interface WorkspaceInfo {
    projectName: string;
    projectRoot: string;
    branch: string;
    files: WebFile[];
}

export interface RenderResult {
    regions: RenderedRegion[];
    output: string;
    segments: RegionSegment[];
    error?: string;
    errorPos?: number;
    warning?: string;
    warningPos?: number;
    ms: number;
    tokens: number;
    uses?: string[];
}

export interface FilePayload {
    content: string;
    /** The variables it renders with, secrets hidden. */
    vars: Record<string, string>;
    secretNames: string[];
    render: RenderResult;
}

export interface OutputInfo {
    /** Relative to the project. */
    output: string;
    entryId: string;
    /** Ids of every source file it is built from, the entry first. */
    sources: string[];
    tokens: number;
    bytes: number;
    status: "up-to-date" | "stale" | "missing" | "failed";
    error?: string;
    kind: "instructions" | "skill" | "reference" | "memory" | "other";
    skillName?: string;
    description?: string;
    descriptionTokens?: number;
}

export interface PreviewBuild {
    outputs: OutputInfo[];
    /** File id → the outputs it feeds. */
    usedBy: Record<string, string[]>;
    ms: number;
    builtAt: string;
}

export interface IncludeInfo {
    /** From 1. */
    line: number;
    reference: string;
    glob: boolean;
    files: { id?: string; display: string }[];
    error?: string;
}

export interface Drift {
    output: string;
    built: string;
    disk: string;
    simulated: boolean;
}

export interface VarFact {
    name: string;
    recipe?: string;
    description?: string;
    type?: string;
    secret: boolean;
    value: string | null;
    answeredBy?: string;
    envName?: string;
    /** Ids of files that use it. */
    usedIn: string[];
}

export interface ConfigReport {
    layers: { path: string; display: string; kind: string; changes: { key: string; value: string; was?: string }[]; text?: string }[];
    settings: { key: string; value: string; layer: string }[];
}

export interface CatalogRecipe {
    key: string;
    repo: string;
    namespace: string;
    name: string;
    description?: string;
    versions: string[];
    latest: string;
    using?: string;
    kinds: string[];
    variables: { name: string; description?: string; secret?: boolean; required?: boolean }[];
    depends: string[];
    files: number;
    acceptsProposals: boolean;
    proposalsInstead?: string;
}

export interface RecipeFileDiff {
    path: string;
    status: "added" | "removed" | "changed" | "same" | "path-only";
    before?: string;
    after?: string;
    sourceChanged: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        "web.serve": { input: { port?: number; launch?: boolean }; result: { url: string; port: number } };
        "web.workspace": { input: Record<string, never>; result: WorkspaceInfo };
        "web.file": { input: { id: string }; result: FilePayload };
        "web.render": { input: { id: string; source: string; overrides?: Record<string, string> }; result: RenderResult };
        "web.includes": { input: { id: string; source: string }; result: { includes: IncludeInfo[] } };
        "web.build": { input: { rerun?: boolean }; result: PreviewBuild };
        "web.output": { input: { path: string }; result: { content: string } };
        "web.drift": { input: { id: string }; result: { drift: Drift | null } };
        "web.variables": { input: Record<string, never>; result: { variables: VarFact[] } };
        "web.builtins": { input: Record<string, never>; result: { names: string[] } };
        "web.config": { input: Record<string, never>; result: ConfigReport };
        "web.recipes": { input: Record<string, never>; result: { recipes: CatalogRecipe[] } };
        "web.recipe-diff": { input: { key: string; from: string; to: string }; result: { files: RecipeFileDiff[] } };
    }
}
