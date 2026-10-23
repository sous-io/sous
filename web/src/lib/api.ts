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
  rendered: string
}

export type RenderResult = {
  regions: Region[]
  output: string
  segments: { start: number; end: number; region: number }[]
  error?: string
  ms: number
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
  render: (id: string, source: string) =>
    call<RenderResult>("/api/render", { method: "POST", body: JSON.stringify({ id, source }) }),
}

export function repoKey(origin: FileOrigin): string {
  if (origin.kind === "recipe") return `${origin.host}/${origin.owner}/${origin.repo}`
  return origin.kind
}

export function recipeKey(origin: FileOrigin): string | null {
  return origin.kind === "recipe" ? `${origin.namespace}/${origin.recipe}` : null
}
