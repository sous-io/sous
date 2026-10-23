import { useMemo, useState } from "react"
import {
  BookOpenIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileIcon,
  FileOutputIcon,
  FlaskConicalIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HouseIcon,
  PackageIcon,
  SearchIcon,
} from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceFile } from "@/lib/api"
import { changedIds, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { MOCK_UPDATES } from "@/mock/data"

type Node = {
  key: string
  name: string
  icon?: "repo" | "namespace" | "recipe" | "project" | "sample" | "folder" | "output"
  hint?: string
  badge?: string
  fileId?: string
  children: Node[]
}

function makeNode(key: string, name: string, extra: Partial<Node> = {}): Node {
  return { key, name, children: [], ...extra }
}

/** Adds a file under `root` along a path of folder names. */
function addPath(root: Node, parts: string[], leaf: Partial<Node>, icon: Node["icon"] = "folder") {
  let node = root
  parts.slice(0, -1).forEach((part) => {
    const key = `${node.key}/${part}`
    let child = node.children.find((c) => c.key === key)
    if (!child) {
      child = makeNode(key, part, { icon })
      node.children.push(child)
    }
    node = child
  })
  const name = parts[parts.length - 1]
  node.children.push(makeNode(`${node.key}/${name}`, name, leaf))
}

function sortTree(node: Node): Node {
  node.children.sort((a, b) => {
    const aDir = a.children.length > 0 ? 0 : 1
    const bDir = b.children.length > 0 ? 0 : 1
    return aDir - bDir || a.name.localeCompare(b.name)
  })
  node.children.forEach(sortTree)
  return node
}

function byFile(files: WorkspaceFile[], projectRoot: string): Node[] {
  const project = makeNode("f:project", projectRoot.split("/").pop() ?? "project", { icon: "project", hint: projectRoot })
  const store = makeNode("f:store", "~/.sous/cache", { icon: "folder", hint: "The machine-wide recipe store" })
  const samples = makeNode("f:sample", "poc-samples", { icon: "sample", hint: "In-memory samples (not on disk)" })
  for (const f of files) {
    if (f.origin.kind === "sample") samples.children.push(makeNode(`f:${f.id}`, f.display.split("/").pop()!, { fileId: f.id }))
    else if (f.origin.kind === "recipe") {
      const o = f.origin
      addPath(store, [o.host, o.owner, o.repo, o.namespace, o.recipe, o.version, ...o.recipePath.split("/")], { fileId: f.id })
    } else addPath(project, f.display.split("/"), { fileId: f.id })
  }
  return [samples, project, store].map(sortTree)
}

function byRecipe(files: WorkspaceFile[]): Node[] {
  const project = makeNode("r:project", "This project", { icon: "project" })
  const samples = makeNode("r:sample", "POC samples", { icon: "sample" })
  const repos = new Map<string, Node>()
  for (const f of files) {
    if (f.origin.kind === "sample") {
      samples.children.push(makeNode(`r:${f.id}`, f.display.split("/").pop()!, { fileId: f.id }))
      continue
    }
    if (f.origin.kind !== "recipe") {
      addPath(project, f.display.split("/"), { fileId: f.id })
      continue
    }
    const o = f.origin
    const repoId = `r:${o.host}/${o.owner}/${o.repo}`
    let repo = repos.get(repoId)
    if (!repo) {
      repo = makeNode(repoId, `${o.owner}/${o.repo}`, { icon: "repo", hint: `${o.host}/${o.owner}/${o.repo}` })
      repos.set(repoId, repo)
    }
    const nsKey = `${repoId}/${o.namespace}`
    let ns = repo.children.find((c) => c.key === nsKey)
    if (!ns) {
      ns = makeNode(nsKey, o.namespace, { icon: "namespace" })
      repo.children.push(ns)
    }
    const recipeKey = `${nsKey}/${o.recipe}`
    let recipe = ns.children.find((c) => c.key === recipeKey)
    if (!recipe) {
      const update = MOCK_UPDATES[`${o.namespace}/${o.recipe}`]
      recipe = makeNode(recipeKey, o.recipe, {
        icon: "recipe",
        badge: o.version,
        hint: update ? `${o.version} → ${update} available (mock)` : o.version,
      })
      ns.children.push(recipe)
    }
    addPath(recipe, o.recipePath.split("/"), { fileId: f.id })
  }
  return [samples, project, ...repos.values()].map(sortTree)
}

function byOutput(files: WorkspaceFile[]): Node[] {
  const root = makeNode("o:root", "Outputs", { icon: "output" })
  for (const f of files) {
    for (const out of f.outputs) addPath(root, out.split("/"), { fileId: f.id, hint: `from ${f.display}` })
  }
  return sortTree(root).children
}

function filterTree(nodes: Node[], query: string, files: Map<string, WorkspaceFile>): Node[] {
  if (!query) return nodes
  const q = query.toLowerCase()
  return nodes
    .map((n) => {
      if (n.fileId) {
        const f = files.get(n.fileId)
        const hay = `${n.name} ${f?.display ?? ""}`.toLowerCase()
        return hay.includes(q) ? n : null
      }
      const children = filterTree(n.children, query, files)
      return children.length ? { ...n, children } : null
    })
    .filter((n): n is Node => n !== null)
}

const ICONS = {
  repo: GitBranchIcon,
  namespace: FolderIcon,
  recipe: PackageIcon,
  project: HouseIcon,
  sample: FlaskConicalIcon,
  folder: FolderIcon,
  output: FileOutputIcon,
}

function TreeNode({ node, depth, forceOpen }: { node: Node; depth: number; forceOpen: boolean }) {
  const activeId = useStore((s) => s.activeId)
  const docs = useStore((s) => s.docs)
  const open = useStore((s) => s.open)
  const [expanded, setExpanded] = useState(depth < 1 || node.icon === "sample")
  const pad = { paddingLeft: 8 + depth * 12 }

  if (node.fileId) {
    const doc = docs[node.fileId]
    const changed = doc && doc.current !== doc.original
    const isTpl = node.name.includes(".tpl.")
    const Icon = isTpl ? FileCode2Icon : FileIcon
    const row = (
      <button
        onClick={() => open(node.fileId!)}
        style={pad}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] hover:bg-accent",
          activeId === node.fileId && "bg-accent font-medium text-accent-foreground",
        )}
      >
        <span className="w-3.5" />
        <Icon className={cn("size-3.5 shrink-0", isTpl ? "text-[var(--cm-liquid)]" : "text-muted-foreground")} />
        <span className="truncate">{node.name}</span>
        {changed && (
          <span
            className={cn("ml-auto size-2 shrink-0 rounded-full", doc.proposedIn ? "bg-emerald-500" : "bg-amber-500")}
          />
        )}
      </button>
    )
    if (!node.hint) return row
    return (
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipContent side="right">{node.hint}</TooltipContent>
      </Tooltip>
    )
  }

  const Icon = node.icon === "folder" && expanded ? FolderOpenIcon : ICONS[node.icon ?? "folder"]
  const isOpen = forceOpen || expanded
  return (
    <Collapsible open={isOpen} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        style={pad}
        title={node.hint}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] hover:bg-accent"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            node.icon === "repo" || node.icon === "recipe" ? "text-sky-500" : "text-muted-foreground",
            node.icon === "sample" && "text-[var(--cm-liquid)]",
          )}
        />
        <span className={cn("truncate", depth === 0 && "font-medium")}>{node.name}</span>
        {node.badge && (
          <span className="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {node.badge}
          </span>
        )}
        {node.icon === "recipe" && node.hint?.includes("available") && (
          <span className="size-1.5 shrink-0 rounded-full bg-sky-500" title={node.hint} />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {node.children.map((child) => (
          <TreeNode key={child.key} node={child} depth={depth + 1} forceOpen={forceOpen} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Explorer() {
  const workspace = useStore((s) => s.workspace)
  const docs = useStore((s) => s.docs)
  const open = useStore((s) => s.open)
  const [view, setView] = useState("recipe")
  const [query, setQuery] = useState("")

  const files = workspace?.files ?? []
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])
  const trees = useMemo(
    () => ({
      file: byFile(files, workspace?.projectRoot ?? ""),
      recipe: byRecipe(files),
      output: byOutput(files),
    }),
    [files, workspace?.projectRoot],
  )
  const nodes = filterTree(trees[view as keyof typeof trees], query, fileMap)
  const changed = changedIds(docs)

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="space-y-2 border-b p-2">
        <Tabs value={view} onValueChange={(v) => setView(v as string)}>
          <TabsList className="w-full">
            <TabsTrigger value="recipe" title="Repository › namespace › recipe › file">
              <PackageIcon /> Recipes
            </TabsTrigger>
            <TabsTrigger value="file" title="Where each file is on disk">
              <FolderIcon /> Files
            </TabsTrigger>
            <TabsTrigger value="output" title="What each output file is built from">
              <FileOutputIcon /> Outputs
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5">
          {changed.length > 0 && (
            <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-1">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
                <BookOpenIcon className="size-3" /> Changed ({changed.length})
              </div>
              {changed.map((id) => (
                <button
                  key={id}
                  onClick={() => open(id)}
                  className="flex w-full items-center gap-1.5 truncate rounded px-2 py-0.5 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn("size-1.5 rounded-full", docs[id].proposedIn ? "bg-emerald-500" : "bg-amber-500")}
                  />
                  <span className="truncate">{fileMap.get(id)?.display}</span>
                </button>
              ))}
            </div>
          )}
          {nodes.map((node) => (
            <TreeNode key={node.key} node={node} depth={0} forceOpen={query.length > 0} />
          ))}
          {nodes.length === 0 && <p className="p-3 text-xs text-muted-foreground">No files match.</p>}
        </div>
      </ScrollArea>
    </div>
  )
}
