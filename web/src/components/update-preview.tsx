// What a recipe update changes for this project: both versions from the recipe
// store, rendered with this project's variables, diffed. REAL; applying the
// update is simulated.

import { useEffect, useState } from "react"
import { diffLines } from "diff"
import { ArrowUpCircleIcon, ChevronRightIcon, FileIcon, LoaderIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { CatalogRecipe } from "@/lib/api"
import { cn } from "@/lib/utils"

type FileDiff = {
  path: string
  status: "added" | "removed" | "changed" | "same" | "path-only"
  before?: string
  after?: string
  sourceChanged: boolean
}

async function fetchDiff(key: string, from: string, to: string): Promise<FileDiff[]> {
  let token = ""
  try {
    token = new URLSearchParams(window.location.search).get("token") ?? sessionStorage.getItem("sous-token") ?? ""
  } catch {
    token = new URLSearchParams(window.location.search).get("token") ?? ""
  }
  const res = await fetch(`/api/recipe-diff?key=${encodeURIComponent(key)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    headers: { "x-sous-token": token },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

function Diff({ before = "", after = "" }: { before?: string; after?: string }) {
  const parts = diffLines(before, after)
  return (
    <div className="overflow-x-auto rounded-md border bg-background font-mono text-[11.5px] leading-5">
      {parts.map((p, i) => {
        if (!p.added && !p.removed) {
          const lines = p.value.replace(/\n$/, "").split("\n")
          if (lines.length <= 6) return <div key={i} className="px-3 whitespace-pre-wrap text-muted-foreground">{lines.join("\n")}</div>
          return (
            <div key={i} className="px-3 whitespace-pre-wrap text-muted-foreground">
              {lines.slice(0, 2).join("\n")}
              <span className="my-1 block rounded bg-muted/60 text-center text-[10px]">··· {lines.length - 4} unchanged lines ···</span>
              {lines.slice(-2).join("\n")}
            </div>
          )
        }
        return (
          <div key={i} className={cn("px-3 whitespace-pre-wrap", p.added ? "diff-add" : "diff-del")}>
            {p.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, j) => (
                <div key={j} className="flex gap-2">
                  <span className={cn("w-3 shrink-0 select-none", p.added ? "text-success" : "text-destructive")}>{p.added ? "+" : "−"}</span>
                  <span className="min-w-0">{line || " "}</span>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

export function UpdatePreview({ recipe, onClose }: { recipe: CatalogRecipe; onClose: () => void }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const from = recipe.using!
  const to = recipe.latest
  useEffect(() => {
    fetchDiff(recipe.key, from, to).then(setFiles).catch((e) => setError(e.message))
  }, [recipe.key, from, to])

  const changed = files?.filter((f) => f.status === "changed" || f.status === "added" || f.status === "removed") ?? []
  const pathOnly = files?.filter((f) => f.status === "path-only") ?? []
  const same = files?.filter((f) => f.status === "same") ?? []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(820px,90vh)] max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircleIcon className="size-4 text-recipe" /> {recipe.namespace}/{recipe.name} {from} → {to}
          </DialogTitle>
          <DialogDescription>
            What your agent would read differently after this update. Both versions are rendered with this project's variables.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-6">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!files && !error && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderIcon className="size-4 animate-spin" /> Rendering both versions…
              </p>
            )}
            {files && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">
                  {changed.length} file{changed.length === 1 ? "" : "s"} change
                </Badge>
                {pathOnly.length > 0 && <Badge variant="outline">{pathOnly.length} only name their new version</Badge>}
                {same.length > 0 && <Badge variant="outline">{same.length} unchanged</Badge>}
              </div>
            )}
            {changed.map((f) => (
              <Collapsible key={f.path} defaultOpen>
                <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent">
                  <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                  <FileIcon className="size-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs">{f.path}</span>
                  <Badge variant="outline" className={cn("ml-auto text-[10px]", f.status === "added" && "text-success", f.status === "removed" && "text-destructive")}>
                    {f.status === "changed" ? "changed" : f.status}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1.5">
                  <Diff before={f.before} after={f.after} />
                </CollapsibleContent>
              </Collapsible>
            ))}
            {pathOnly.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
                  <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
                  {pathOnly.length} files change only because they name their own path, which includes the version
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1 pt-1 pl-6 font-mono text-[11px] text-muted-foreground">
                  {pathOnly.map((f) => (
                    <div key={f.path}>{f.path}</div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center gap-3 border-t px-6 py-3">
          <code className="rounded bg-muted px-2 py-1 font-mono text-[11px]">
            sous subscription update {recipe.namespace}/{recipe.name}
          </code>
          <Button
            className="ml-auto"
            onClick={() => {
              toast.success(`Updated ${recipe.namespace}/${recipe.name} to ${to} (simulated)`)
              onClose()
            }}
          >
            <ArrowUpCircleIcon /> Update to {to}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
