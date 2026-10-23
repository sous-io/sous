// Client for the `sous serve` JSON API. The token comes from the URL the CLI
// opened (?token=...), and is kept for the tab's lifetime.

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

function token(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("token")
  try {
    if (fromUrl) sessionStorage.setItem("sous-token", fromUrl)
    return fromUrl ?? sessionStorage.getItem("sous-token") ?? ""
  } catch {
    return fromUrl ?? ""
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", "x-sous-token": token(), ...(init?.headers ?? {}) },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}

export const api = {
  workspace: () => call<WorkspaceInfo>("/api/workspace"),
  file: (id: string) => call<FilePayload>(`/api/file?id=${encodeURIComponent(id)}`),
  render: (id: string, source: string, overrides?: Record<string, string>) =>
    call<RenderResult>("/api/render", { method: "POST", body: JSON.stringify({ id, source, overrides }) }),
  build: (rerun = false) => call<PreviewBuild>("/api/build", rerun ? { method: "POST" } : undefined),
  variables: () => call<VarFact[]>("/api/variables"),
  recipes: () => call<CatalogRecipe[]>("/api/recipes"),
  builtins: () => call<string[]>("/api/builtins"),
  drift: (id: string) => call<{ drift: Drift | null }>(`/api/drift?id=${encodeURIComponent(id)}`),
  output: (path: string) => call<{ content: string }>(`/api/output?path=${encodeURIComponent(path)}`),
}

export function repoKey(origin: FileOrigin): string {
  if (origin.kind === "recipe") return `${origin.host}/${origin.owner}/${origin.repo}`
  return origin.kind
}

export function recipeKey(origin: FileOrigin): string | null {
  return origin.kind === "recipe" ? `${origin.namespace}/${origin.recipe}` : null
}
