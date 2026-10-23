// The "Send changes" flow's logic: where each edit goes, what changed, the
// checks that run before proposing, the suggested version raise, and the
// changelog `sous repo submit` appends. All of it is computed from real data
// (your edits, the store's manifests, the repo index, and upstream HEAD from
// /api/contribute-info). Only the proposing itself is simulated.

import { applyPatch, createPatch, structuredPatch } from "diff"
import { create } from "zustand"
import type { WorkspaceFile } from "@/lib/api"
import type { OpenDoc } from "@/lib/store"
import { bump, type BumpKind } from "@/mock/data"

// ---- /api/contribute-info ---------------------------------------------------------------------

export type RecipeInfo = {
  key: string
  repoKey: string
  pinned: string
  description?: string
  manifestPath: string
  repoPath: string
  variables: { name: string; type?: string; required?: boolean; secret?: boolean; prompt?: string }[]
  submissions: { allowed: boolean; instead?: string } | null
  redirect?: { owner: string; repo: string; path: string; canPush: boolean | null }
  released: { version: string; releasedAt?: string; tag?: string }[]
  latestReleased?: string
  headVersion: string | null
  headTagged: boolean | null
}

export type RepoInfo = {
  key: string
  host: string
  owner: string
  repo: string
  name?: string
  contribute?: string
  manifestSource: "checkout" | "github" | null
  checkout: { path: string; branch: string; head: string; when: string; subject: string } | null
  defaultBranch: string | null
  head: { sha: string; date: string; message: string } | null
  canPush: boolean | null
  indexGeneratedAt?: string
}

export type ContributeInfo = {
  gh: { installed: boolean; signedIn: boolean; account?: string; host: string; message: string; ms: number }
  git: { userName?: string; userEmail?: string }
  repos: Record<string, RepoInfo>
  recipes: Record<string, RecipeInfo>
  files: Record<string, { upstreamPath: string; upstream: string | null; recipe: string }>
  ms: number
}

function token(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("token")
  try {
    return fromUrl ?? sessionStorage.getItem("sous-token") ?? ""
  } catch {
    return fromUrl ?? ""
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", "x-sous-token": token() } })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}

type InfoState = {
  info: ContributeInfo | null
  loading: boolean
  error: string | null
  secretHits: { id: string; line: number; name: string }[]
  load: (ids: string[]) => Promise<void>
  scanSecrets: (added: Record<string, string[]>) => Promise<void>
}

export const useContributeInfo = create<InfoState>((set) => ({
  info: null,
  loading: false,
  error: null,
  secretHits: [],
  load: async (ids) => {
    set({ loading: true, error: null })
    try {
      const info = await call<ContributeInfo>(`/api/contribute-info?ids=${ids.map(encodeURIComponent).join(",")}`)
      set({ info, loading: false })
    } catch (error) {
      set({ loading: false, error: (error as Error).message })
    }
  },
  scanSecrets: async (added) => {
    try {
      const { hits } = await call<{ hits: InfoState["secretHits"] }>("/api/contribute-info", {
        method: "POST",
        body: JSON.stringify({ added }),
      })
      set({ secretHits: hits })
    } catch {
      set({ secretHits: [] })
    }
  },
}))

// ---- Destinations -----------------------------------------------------------------------------

export type GroupKind = "pr" | "core" | "project" | "sample"

export type Group = {
  key: string
  kind: GroupKind
  /** owner/repo for pr and core, the project name otherwise. */
  title: string
  owner?: string
  repo?: string
  host?: string
  /** For core: the recipe repo the files came from, and the path they go to instead. */
  from?: string
  intoPath?: string
  instead?: string
  files: WorkspaceFile[]
  recipes: { name: string; pinned: string }[]
}

/** Core recipes of the official repo are machine-written from sous-io/sous; the manifest says so. */
function isRedirected(f: WorkspaceFile, info: ContributeInfo | null): RecipeInfo["redirect"] | null {
  if (f.origin.kind !== "recipe") return null
  const key = `${f.origin.namespace}/${f.origin.recipe}`
  const recipe = info?.recipes[key]
  if (recipe) return recipe.submissions?.allowed === false && recipe.redirect ? recipe.redirect : null
  // Before the manifest is read: the known case.
  if (f.origin.repo === "sous-recipes" && f.origin.namespace === "core")
    return { owner: "sous-io", repo: "sous", path: `recipes/${key}/`, canPush: null }
  return null
}

export function groupChanges(files: WorkspaceFile[], ids: string[], projectName: string, info: ContributeInfo | null): Group[] {
  const groups = new Map<string, Group>()
  for (const id of ids) {
    const f = files.find((x) => x.id === id)
    if (!f) continue
    const o = f.origin
    let group: Group
    if (o.kind === "recipe") {
      const redirect = isRedirected(f, info)
      const key = redirect ? `${o.host}/${redirect.owner}/${redirect.repo}` : `${o.host}/${o.owner}/${o.repo}`
      group = groups.get(key) ?? {
        key,
        kind: redirect ? "core" : "pr",
        title: redirect ? `${redirect.owner}/${redirect.repo}` : `${o.owner}/${o.repo}`,
        owner: redirect?.owner ?? o.owner,
        repo: redirect?.repo ?? o.repo,
        host: o.host,
        from: redirect ? `${o.owner}/${o.repo}` : undefined,
        intoPath: redirect?.path,
        instead: redirect ? info?.recipes[`${o.namespace}/${o.recipe}`]?.submissions?.instead : undefined,
        files: [],
        recipes: [],
      }
      const name = `${o.namespace}/${o.recipe}`
      if (!group.recipes.some((r) => r.name === name)) group.recipes.push({ name, pinned: o.version })
      groups.set(key, group)
    } else if (o.kind === "sample") {
      group = groups.get("sample") ?? { key: "sample", kind: "sample", title: "POC sample", files: [], recipes: [] }
      groups.set("sample", group)
    } else {
      group = groups.get("project") ?? { key: "project", kind: "project", title: projectName, files: [], recipes: [] }
      groups.set("project", group)
    }
    group.files.push(f)
  }
  const order: Record<GroupKind, number> = { pr: 0, core: 1, project: 2, sample: 3 }
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind])
}

// ---- Diffs and the merge onto upstream --------------------------------------------------------

export function lineStats(a: string, b: string): { added: number; removed: number } {
  const patch = structuredPatch("a", "b", a, b, "", "", { context: 0 })
  let added = 0
  let removed = 0
  for (const h of patch.hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++
      else if (l.startsWith("-")) removed++
    }
  return { added, removed }
}

export function addedLines(a: string, b: string): { text: string; newLine: number }[] {
  const patch = structuredPatch("a", "b", a, b, "", "", { context: 0 })
  const out: { text: string; newLine: number }[] = []
  for (const h of patch.hunks) {
    let n = h.newStart
    for (const l of h.lines) {
      if (l.startsWith("+")) out.push({ text: l.slice(1), newLine: n++ })
      else if (!l.startsWith("-")) n++
    }
  }
  return out
}

export type MergeResult = { state: "no-upstream" | "same" | "clean" | "conflict"; text: string; upstream: string | null }

/** A 3-way apply: your edit (pinned → current) applied onto the file at upstream HEAD. */
export function mergeOntoUpstream(doc: OpenDoc, upstream: string | null | undefined): MergeResult {
  if (upstream == null) return { state: "no-upstream", text: doc.current, upstream: null }
  if (upstream === doc.original) return { state: "same", text: doc.current, upstream }
  const patch = createPatch("file", doc.original, doc.current)
  const merged = applyPatch(upstream, patch, { fuzzFactor: 2 })
  if (merged === false) return { state: "conflict", text: doc.current, upstream }
  return { state: "clean", text: merged, upstream }
}

// ---- "Make it generic" ------------------------------------------------------------------------

export type GenericHit = { id: string; file: string; line: number; text: string; name: string; value: string }

const BORING = /^(true|false|always|never|yes|no|none|null|main|master)$/i

/** Added lines that contain one of this project's own variable values, typed as text. */
export function genericHits(f: WorkspaceFile, doc: OpenDoc): GenericHit[] {
  const candidates = Object.entries(doc.vars)
    .filter(([, v]) => typeof v === "string" && v !== "••••••" && v.length >= 4 && !BORING.test(v) && (/[^A-Za-z]/.test(v) || v.length >= 10))
    // Prefer a recipe's own variable names over sous's automatic ones, and longer values first.
    .sort((a, b) => b[1].length - a[1].length || Number(a[0].startsWith("sous")) - Number(b[0].startsWith("sous")))
  const hits: GenericHit[] = []
  for (const line of addedLines(doc.original, doc.current)) {
    const plain = line.text.replace(/\{\{.*?\}\}|\{%.*?%\}/g, "")
    for (const [name, value] of candidates) {
      if (!plain.includes(value)) continue
      if (hits.some((h) => h.line === line.newLine && h.value.includes(value))) continue
      hits.push({ id: f.id, file: f.display, line: line.newLine, text: line.text, name, value })
    }
  }
  return hits
}

export function replaceOnLine(source: string, line: number, value: string, name: string): string {
  const lines = source.split("\n")
  const i = line - 1
  if (lines[i] === undefined) return source
  lines[i] = lines[i].split(value).join(`{{ ${name} }}`)
  return lines.join("\n")
}

// ---- Version raise ----------------------------------------------------------------------------

export type VersionPlan = {
  recipe: string
  pinned: string
  /** The version the raise starts from: upstream HEAD's manifest, else the newest release, else pinned. */
  base: string
  baseSource: "head" | "released" | "pinned"
  /** HEAD's version has no tag yet: someone already raised it, so no raise is needed. */
  alreadyRaised: boolean
  /** Raised by the open proposal these edits are added to. */
  raisedIn?: number
  suggested: BumpKind
  reason: string
  manifestPath: string
}

function frontmatterName(text: string): string | undefined {
  return /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(text)?.[1]?.trim()
}

/** Suggests patch, minor or major from what the edits do (idea 4). */
export function suggestRaise(files: { f: WorkspaceFile; doc: OpenDoc }[], declared: string[]): { kind: BumpKind; reason: string } {
  for (const { doc } of files) {
    const was = frontmatterName(doc.original)
    const now = frontmatterName(doc.current)
    if (was && now && was !== now)
      return { kind: "major", reason: `you renamed the skill ${was} → ${now}, so anything that calls /${was} breaks` }
  }
  const varRef = /\{\{-?\s*([A-Za-z_][\w]*)/g
  for (const { doc } of files) {
    const before = new Set([...doc.original.matchAll(varRef)].map((m) => m[1]))
    const fresh = [...doc.current.matchAll(varRef)].map((m) => m[1]).filter((n) => !before.has(n) && !n.startsWith("sous"))
    const undeclared = fresh.find((n) => !declared.includes(n) && !(n in doc.vars))
    if (undeclared) return { kind: "minor", reason: `you use a new variable, ${undeclared}, so it needs declaring as an optional variable` }
    if (fresh.length) return { kind: "minor", reason: `you now use the variable ${fresh[0]} here` }
  }
  // A section is new only when the number of headings goes up. A heading whose
  // text changed in place (one removed, one added) is wording.
  const headingRe = /^#{1,6}\s+\S/
  for (const { doc } of files) {
    const before = doc.original.split("\n").filter((l) => headingRe.test(l)).length
    const after = doc.current.split("\n").filter((l) => headingRe.test(l)).length
    if (after <= before) continue
    const heading = addedLines(doc.original, doc.current).find((l) => headingRe.test(l.text))
    if (heading) return { kind: "minor", reason: `you added a section, “${heading.text.replace(/^#+\s*/, "")}”` }
  }
  let added = 0
  let removed = 0
  for (const { doc } of files) {
    const s = lineStats(doc.original, doc.current)
    added += s.added
    removed += s.removed
  }
  if (added - removed > 12) return { kind: "minor", reason: `you added ${added - removed} lines of new guidance` }
  return { kind: "patch", reason: "wording or a fix: nothing new, nothing removed" }
}

export function planVersion(
  recipe: { name: string; pinned: string },
  files: { f: WorkspaceFile; doc: OpenDoc }[],
  info: ContributeInfo | null,
): VersionPlan {
  const r = info?.recipes[recipe.name]
  const base = r?.headVersion ?? r?.latestReleased ?? recipe.pinned
  const baseSource = r?.headVersion ? "head" : r?.latestReleased ? "released" : "pinned"
  const { kind, reason } = suggestRaise(files, r?.variables.map((v) => v.name) ?? [])
  return {
    recipe: recipe.name,
    pinned: recipe.pinned,
    base,
    baseSource,
    alreadyRaised: r?.headTagged === false,
    suggested: kind,
    reason,
    manifestPath: `${r?.repoPath ?? `recipes/${recipe.name}`}/sous.recipe.yaml`,
  }
}

export function targetVersion(plan: VersionPlan, kind: BumpKind | undefined): string {
  return plan.alreadyRaised ? plan.base : bump(plan.base, kind ?? plan.suggested)
}

// ---- Text -------------------------------------------------------------------------------------

export function shortName(f: WorkspaceFile): string {
  const parts = f.display.split("/")
  const skill = parts.indexOf("skills")
  if (skill >= 0 && parts[skill + 1]) return parts[skill + 1]
  return parts[parts.length - 1].replace(/\.tpl\.md$|\.md$/, "")
}

export function defaultTitle(group: Group, files: WorkspaceFile[]): string {
  const names = [...new Set(files.map(shortName))]
  const what = `${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`
  if (group.kind === "project") return `Update ${what}`
  const recipe = group.recipes.length === 1 ? group.recipes[0].name : `${group.recipes.length} recipes`
  return `${recipe}: improve ${what}`
}

// ---- What the change does, in words (built from the diff, never invented) ------------------

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

function clip(text: string, n = 80): string {
  const t = text.trim().replace(/\s+/g, " ")
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

/** The heading a line sits under, counting up from a 1-based line number. */
function sectionAt(lines: string[], line: number): string | null {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = HEADING.exec(lines[i])
    if (m) return m[2]
  }
  return null
}

/** One plain sentence per changed spot: "Adds “…” under “Jargon”". */
export function describeEdits(a: string, b: string): string[] {
  const patch = structuredPatch("a", "b", a, b, "", "", { context: 0 })
  const lines = b.split("\n")
  const out: string[] = []
  for (const h of patch.hunks) {
    const added = h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).filter((l) => l.trim())
    const removed = h.lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1)).filter((l) => l.trim())
    if (!added.length && !removed.length) continue
    const hAdd = added.length === 1 ? HEADING.exec(added[0]) : null
    const hDel = removed.length === 1 ? HEADING.exec(removed[0]) : null
    if (hAdd && hDel) {
      out.push(`Renames the section “${clip(hDel[2], 50)}” to “${clip(hAdd[2], 50)}”`)
      continue
    }
    const section = sectionAt(lines, h.newStart)
    const under = section ? ` under “${clip(section, 40)}”` : ""
    if (added.length === 1 && removed.length === 1) {
      const was = removed[0].trim()
      const now = added[0].trim()
      // An appended sentence reads better as what was added.
      // Quote only what changed: strip the text both versions share at the start and end.
      let pre = 0
      while (pre < was.length && pre < now.length && was[pre] === now[pre]) pre++
      let suf = 0
      while (suf < was.length - pre && suf < now.length - pre && was[was.length - 1 - suf] === now[now.length - 1 - suf]) suf++
      // Widen to whole words.
      while (pre > 0 && /\S/.test(was[pre - 1])) pre--
      while (suf > 0 && /\S/.test(was[was.length - suf])) suf--
      const oldPart = was.slice(pre, was.length - suf).trim()
      const newPart = now.slice(pre, now.length - suf).trim()
      if (!oldPart && newPart) out.push(`Adds “${clip(newPart)}”${under}`)
      else if (oldPart && !newPart) out.push(`Removes “${clip(oldPart)}”${under}`)
      else out.push(`Rewords “${clip(oldPart, 60)}” as “${clip(newPart, 60)}”${under}`)
    } else if (added.length && !removed.length) {
      out.push(`Adds “${clip(added[0])}”${added.length > 1 ? ` and ${added.length - 1} more line${added.length === 2 ? "" : "s"}` : ""}${under}`)
    } else if (removed.length && !added.length) {
      out.push(`Removes “${clip(removed[0])}”${removed.length > 1 ? ` and ${removed.length - 1} more line${removed.length === 2 ? "" : "s"}` : ""}${under}`)
    } else {
      out.push(`Rewrites ${Math.max(added.length, removed.length)} lines${under}`)
    }
  }
  return out
}

function whatChanges(files: { f: WorkspaceFile; a: string; b: string }[]): string[] {
  const many = files.length > 1
  return files.flatMap(({ f, a, b }) => describeEdits(a, b).map((d) => (many ? `- \`${shortName(f)}\`: ${d}.` : `- ${d}.`)))
}

/** The description the sheet starts with: the plain facts, so one click can propose. */
export function defaultBody(files: { f: WorkspaceFile; doc: OpenDoc }[]): string {
  return ["## What changes", "", ...whatChanges(files.map(({ f, doc }) => ({ f, a: doc.original, b: doc.current }))), "", "Checked in `sous serve` with my project's variables."].join("\n")
}

/** A short commit message for edits added to an open proposal: what changed since the last push. */
export function commitMessage(files: { f: WorkspaceFile; doc: OpenDoc }[]): string {
  const said = files.flatMap(({ f, doc }) => describeEdits(doc.proposedContent ?? doc.original, doc.current).map((d) => (files.length > 1 ? `${shortName(f)}: ${d}` : d)))
  if (!said.length) return "Follow-up edits"
  return said.length === 1 ? said[0] : `${said[0]} (and ${said.length - 1} more)`
}

/** What "Write it with Claude" produces in this mock: built from the diff. The why is left to you. */
export function claudeBody(files: { f: WorkspaceFile; doc: OpenDoc }[]): string {
  const names = [...new Set(files.map(({ f }) => `\`${shortName(f)}\``))].join(", ")
  return [
    "## What changes",
    "",
    `In ${names}:`,
    "",
    ...whatChanges(files.map(({ f, doc }) => ({ f, a: doc.original, b: doc.current }))),
    "",
    "## Why",
    "",
    "Why: …",
    "",
    "## How I checked it",
    "",
    "Rendered with my project's variables in `sous serve`, and read the output my agent gets.",
  ].join("\n")
}

/** The changelog `sous repo submit` appends, in the same words (src/lib/repos/release/changelog.ts). */
export function changelogFor(
  group: Group,
  plans: VersionPlan[],
  bumps: Record<string, BumpKind>,
  baseBranch: string,
): string {
  const lines = ["## What merging this changes", ""]
  lines.push(`Generated by \`sous repo submit\` from the manifests this change carries, compared with the branch '${baseBranch}'.`)
  if (group.kind === "core") {
    lines.push("", "Merging changes no recipe, namespace, version or variable.")
    return lines.join("\n")
  }
  const changes = plans.filter((p) => !p.alreadyRaised).map((p) => `- \`${p.recipe}\`: ${p.base} becomes ${targetVersion(p, bumps[p.recipe])}`)
  const raisedAlready = plans.filter((p) => p.alreadyRaised)
  if (changes.length) lines.push("", "**Version changes**", "", ...changes)
  if (raisedAlready.length)
    lines.push("", "**Version changes**", "", ...raisedAlready.map((p) => p.raisedIn ? `- \`${p.recipe}\`: ${p.pinned} becomes ${p.base}` : `- \`${p.recipe}\`: already raised to ${p.base} on '${baseBranch}', not released yet`))
  return lines.join("\n")
}

// ---- Steps (simulated) ------------------------------------------------------------------------

export type Step = { label: string; done: string; command: string; ms: number }

export function stepsFor(opts: {
  group: Group
  branch: string
  canPush: boolean | null
  account?: string
  baseBranch: string
  headSha?: string
  plans: VersionPlan[]
  bumps: Record<string, BumpKind>
  title: string
  draft: boolean
  fileCount: number
  addTo?: { number: number; branch: string }
}): Step[] {
  const { group, branch, canPush, account, baseBranch, headSha, plans, bumps, title, draft, fileCount, addTo } = opts
  if (group.kind === "project") {
    return [
      { label: "Writing your edits to disk", done: `Wrote ${fileCount} file${fileCount === 1 ? "" : "s"} in this project`, command: "# sous serve writes the files in place", ms: 500 },
      { label: "Rebuilding", done: "Rebuilt the outputs your agent reads", command: "sous build", ms: 700 },
    ]
  }
  const repoName = group.repo ?? group.title
  const fork = canPush === false ? `${account ?? "you"}/${repoName}` : null
  const raised = plans.filter((p) => !p.alreadyRaised)
  const useBranch = addTo?.branch ?? branch
  const steps: Step[] = [
    {
      label: addTo ? `Reusing the branch of #${addTo.number}` : `Linking ${group.title} on a new branch`,
      done: addTo ? `Checked out ${useBranch}` : `Checkout at .sous/repos/${group.title} on ${useBranch}`,
      command: addTo
        ? `sous repo link ${repoName} --branch ${useBranch}`
        : `sous repo link ${repoName} --latest --generate-branch`,
      ms: 750,
    },
    {
      label: `Applying your ${fileCount} edit${fileCount === 1 ? "" : "s"} onto ${baseBranch}`,
      done: `Applied cleanly onto ${baseBranch}${headSha ? ` (${headSha})` : ""}`,
      command: `# sous serve: a 3-way merge of each file (your pinned version → your edit, onto ${baseBranch})\ngit merge-file <yours> <pinned> <upstream>`,
      ms: 650,
    },
  ]
  if (group.kind === "pr" && raised.length)
    steps.push({
      label: "Raising recipe versions",
      done: raised.map((p) => `${p.recipe} → ${targetVersion(p, bumps[p.recipe])}`).join(", "),
      command: raised.map((p) => `# ${p.manifestPath}\nversion: ${targetVersion(p, bumps[p.recipe])}`).join("\n"),
      ms: 450,
    })
  steps.push(
    {
      label: "Checking it the way maintainers will",
      done: "Repository validates · sous.index.json untouched",
      command: "sous repo release --check",
      ms: 800,
    },
    {
      label: "Committing",
      done: `Committed “${title.length > 48 ? title.slice(0, 48) + "…" : title}”`,
      command: `git commit -F <title, description and changelog>`,
      ms: 450,
    },
    {
      label: fork ? `Forking and pushing` : "Pushing",
      done: fork ? `Pushed to your fork ${fork}` : `Pushed ${useBranch} to ${group.title}`,
      command: fork ? `gh repo fork ${group.title} --remote --remote-name fork\ngit push fork ${useBranch}` : `git push origin ${useBranch}`,
      ms: 900,
    },
    {
      label: addTo ? `Updating pull request #${addTo.number}` : `Opening the pull request${draft ? " as a draft" : ""}`,
      done: addTo ? `Updated #${addTo.number}` : "Opened",
      command: `sous repo submit${draft ? " --draft" : ""} --title ${JSON.stringify(title)} --body-file <description>`,
      ms: 900,
    },
  )
  return steps
}

export function relTime(iso: string | undefined): string {
  if (!iso) return ""
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} hours ago`
  return `${Math.round(s / 86400)} days ago`
}

// ---- Pull request numbers (from /api/my-prs) and the "Just sent" card -------------------------

type NumbersState = {
  /** Highest known issue or PR number, by "owner/repo". */
  latest: Record<string, number>
  loaded: boolean
  load: () => Promise<void>
}

export const usePrNumbers = create<NumbersState>((set, get) => ({
  latest: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return
    try {
      const data = await call<{ repos: { key: string; latestNumber?: number; prs: { number: number }[] }[] }>("/api/my-prs")
      const latest: Record<string, number> = {}
      for (const r of data.repos) {
        const n = Math.max(r.latestNumber ?? 0, ...r.prs.map((p) => p.number))
        if (n > 0) latest[r.key.toLowerCase()] = n
      }
      set({ latest, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
}))

/** The number GitHub would give the next pull request, past any simulated in this session. */
export function nextPrNumber(groupKey: string, taken: number[]): number {
  const ownerRepo = groupKey.replace(/^[^/]+\//, "").toLowerCase()
  let base = usePrNumbers.getState().latest[ownerRepo]
  if (base === undefined) {
    // Unknown (gh offline): guess once, then count up from the guess.
    base = 40 + Math.floor(Math.random() * 20)
    usePrNumbers.setState((s) => ({ latest: { ...s.latest, [ownerRepo]: base! } }))
  }
  return Math.max(base, ...taken) + 1
}

/** The proposal "Track it" should pin at the top of Proposals, briefly highlighted. */
export const useJustSent = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}))
