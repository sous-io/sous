// The web editor's data, from the `web.*` intents run over the socket (lib/socket.ts).

import { sous } from "./socket"

export type FileOrigin =
  | { kind: "project" }
  | {
      kind: "recipe"
      host: string
      owner: string
      repo: string
      namespace: string
      recipe: string
      version: string
      recipePath: string
    }
  | { kind: "external" }
  | { kind: "sample" }

export type WorkspaceFile = {
  id: string
  path: string
  display: string
  origin: FileOrigin
  isTpl: boolean
  role: "entry" | "partial"
  outputs: string[]
}

export type WorkspaceInfo = {
  projectName: string
  projectRoot: string
  branch: string
  files: WorkspaceFile[]
}

export type Region = {
  from: number
  to: number
  kind: "output" | "tag" | "block"
  label: string
  head: string
  rendered: string
  branches?: string[]
  ran?: number[]
}

export type RenderResult = {
  regions: Region[]
  output: string
  segments: { start: number; end: number; region: number }[]
  error?: string
  errorPos?: number
  ms: number
  tokens: number
  uses?: string[]
  warning?: string
  warningPos?: number
}

export type OutputInfo = {
  output: string
  entryId: string
  sources: string[]
  tokens: number
  bytes: number
  status: "up-to-date" | "stale" | "missing" | "failed"
  error?: string
  kind: "instructions" | "skill" | "reference" | "memory" | "other"
  skillName?: string
  description?: string
  descriptionTokens?: number
}

export type VarFact = {
  name: string
  recipe?: string
  description?: string
  type?: string
  secret: boolean
  value: string | null
  answeredBy?: string
  envName?: string
  usedIn: string[]
}

export type CatalogRecipe = {
  key: string
  repo: string
  namespace: string
  name: string
  description?: string
  versions: string[]
  latest: string
  using?: string
  kinds: string[]
  variables: { name: string; description?: string; secret?: boolean; required?: boolean }[]
  depends: string[]
  files: number
  acceptsProposals: boolean
  proposalsInstead?: string
}

export type ConfigReport = {
  layers: { path: string; display: string; kind: string; changes: { key: string; value: string; was?: string }[]; text?: string }[]
  settings: { key: string; value: string; layer: string }[]
}

export type Drift = { output: string; built: string; disk: string; simulated: boolean }

export type PreviewBuild = {
  outputs: OutputInfo[]
  usedBy: Record<string, string[]>
  ms: number
  builtAt: string
}

export type FilePayload = {
  content: string
  vars: Record<string, string>
  secretNames: string[]
  render: RenderResult
}

/** Runs a web editor intent; every one returns an object, so lists come wrapped. */
const run = <T>(intent: string, input?: unknown) => sous.run<T>(intent, input)

export const api = {
  workspace: () => run<WorkspaceInfo>("web.workspace"),
  file: (id: string) => run<FilePayload>("web.file", { id }),
  render: (id: string, source: string, overrides?: Record<string, string>, signal?: AbortSignal) =>
    sous.run<RenderResult>("web.render", { id, source, ...(overrides ? { overrides } : {}) }, { signal }),
  build: (rerun = false) => run<PreviewBuild>("web.build", { rerun }),
  variables: () => run<{ variables: VarFact[] }>("web.variables").then((r) => r.variables),
  recipes: () => run<{ recipes: CatalogRecipe[] }>("web.recipes").then((r) => r.recipes),
  builtins: () => run<{ names: string[] }>("web.builtins").then((r) => r.names),
  config: () => run<ConfigReport>("web.config"),
  includes: (id: string, source: string) =>
    run<{ includes: { line: number; reference: string; glob: boolean; files: { id?: string; display: string }[]; error?: string }[] }>("web.includes", {
      id,
      source,
    }).then((r) => r.includes),
  drift: (id: string) => run<{ drift: Drift | null }>("web.drift", { id }),
  output: (path: string) => run<{ content: string }>("web.output", { path }),
  recipeDiff: <T>(key: string, from: string, to: string) => run<{ files: T[] }>("web.recipe-diff", { key, from, to }).then((r) => r.files),
  contributeInfo: <T>(ids: string[]) => run<T>("web.contribute-info", { ids }),
  scanSecrets: <T>(added: Record<string, string[]>) => run<T>("web.scan-secrets", { added }),
  myPrs: <T>(fresh: boolean) => run<T>("web.my-prs", { fresh }),
}

export function repoKey(origin: FileOrigin): string {
  if (origin.kind === "recipe") return `${origin.host}/${origin.owner}/${origin.repo}`
  return origin.kind
}

export function recipeKey(origin: FileOrigin): string | null {
  return origin.kind === "recipe" ? `${origin.namespace}/${origin.recipe}` : null
}
