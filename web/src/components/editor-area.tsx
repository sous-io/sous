import { useEffect, useMemo, useState } from "react"
import {
  ChevronRightIcon,
  CodeIcon,
  EyeIcon,
  FileCode2Icon,
  FileIcon,
  GitPullRequestArrowIcon,
  HistoryIcon,
  LoaderIcon,
  PanelRightIcon,
  RotateCcwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
  ZapIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { LiquidEditor } from "@/editor/liquid-editor"
import { Inspector, useActiveRegion } from "@/components/inspector"
import type { Region, WorkspaceFile } from "@/lib/api"
import { useStore, type Mode } from "@/lib/store"
import { cn } from "@/lib/utils"

function useFile(id: string | null): WorkspaceFile | undefined {
  const files = useStore((s) => s.workspace?.files)
  return useMemo(() => files?.find((f) => f.id === id), [files, id])
}

function FileTabs() {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  const docs = useStore((s) => s.docs)
  const files = useStore((s) => s.workspace?.files ?? [])
  const open = useStore((s) => s.open)
  const close = useStore((s) => s.close)

  return (
    <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b bg-sidebar">
      {tabs.map((id) => {
        const f = files.find((x) => x.id === id)
        const doc = docs[id]
        const changed = doc && doc.current !== doc.original
        const name = f?.display.split("/").pop() ?? id
        return (
          <div
            key={id}
            onClick={() => open(id)}
            className={cn(
              "group flex h-full cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
              activeId === id
                ? "bg-surface-editor text-foreground shadow-[inset_0_2px_0_var(--brand)]"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {f?.isTpl ? (
              <FileCode2Icon className="size-3.5 text-liquid" />
            ) : (
              <FileIcon className="size-3.5" />
            )}
            <span className="max-w-48 truncate">{name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                close(id)
              }}
              className="ml-1 grid size-4 place-items-center rounded hover:bg-muted"
            >
              {changed ? (
                <span className="size-2 rounded-full bg-warning group-hover:hidden" />
              ) : null}
              <XIcon className={cn("size-3", changed ? "hidden group-hover:block" : "opacity-0 group-hover:opacity-100")} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Breadcrumb({ file }: { file: WorkspaceFile }) {
  const o = file.origin
  const parts =
    o.kind === "recipe"
      ? [`${o.owner}/${o.repo}`, o.namespace, `${o.recipe}@${o.version}`, ...o.recipePath.split("/")]
      : o.kind === "sample"
        ? ["POC samples", ...file.display.split("/").slice(1)]
        : ["This project", ...file.display.split("/")]
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRightIcon className="size-3 shrink-0 opacity-60" />}
          <span className={cn("truncate", i === parts.length - 1 && "font-medium text-foreground")}>{p}</span>
        </span>
      ))}
    </div>
  )
}

function OriginBanner({ file }: { file: WorkspaceFile }) {
  const doc = useStore((s) => s.docs[file.id])
  useStore((s) => s.mode)
  const branch = useStore((s) => s.workspace?.branch)
  const openContribute = useStore((s) => s.openContribute)
  const changed = doc && doc.current !== doc.original
  const o = file.origin
  const usedBy = useStore((s) => s.build?.usedBy[file.id]?.length ?? 0)
  const usedChip =
    file.role === "partial" && usedBy > 0 ? (
      <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand" title="See the Used by tab">
        included in {usedBy} outputs
      </span>
    ) : null

  if (doc?.proposedIn) {
    const proposal = useStore.getState().proposals.find((p) => p.id === doc.proposedIn)
    return (
      <div className="flex items-center gap-2 border-b bg-success/10 px-4 py-1.5 text-xs">
        <GitPullRequestArrowIcon className="size-3.5 text-success" />
        <span>
          Proposed in <b>#{proposal?.number}</b> “{proposal?.title}”. Keep editing to add to it.
        </span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => useStore.getState().setPage("proposals")}>
          Track it
        </Button>
      </div>
    )
  }

  if (o.kind === "recipe") {
    return (
      <div className="flex items-center gap-2 border-b bg-recipe/8 px-4 py-1.5 text-xs">
        <Badge variant="outline" className="h-5 border-recipe/40 text-recipe">
          recipe
        </Badge>
        <span className="truncate text-muted-foreground">
          From <b className="text-foreground">{o.namespace}/{o.recipe}</b> {o.version} in {o.owner}/{o.repo}.{" "}
          {changed ? "You changed it; send the change upstream when you're ready." : "Edit freely: sous keeps a copy for you to propose upstream."}
        </span>
        {usedChip}
        {changed && (
          <Button size="xs" className="ml-auto" onClick={() => openContribute(file.id)}>
            <GitPullRequestArrowIcon /> Propose upstream
          </Button>
        )}
      </div>
    )
  }
  if (o.kind === "sample") {
    return (
      <div className="flex items-center gap-2 border-b bg-liquid-soft px-4 py-1.5 text-xs">
        <SparklesIcon className="size-3.5 text-liquid" />
        <span className="text-muted-foreground">
          A sample template, rendered with <b className="text-foreground">this project's real variables</b>.{" "}
          {useStore.getState().mode === "source"
            ? "This is the plain source. Switch to Rendered to see each Liquid section's output."
            : "Click any highlighted section to edit its Liquid; press Esc or click outside to re-render."}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 border-b bg-project/8 px-4 py-1.5 text-xs">
      <Badge variant="outline" className="h-5 border-project/40 text-project">
        project
      </Badge>
      <span className="text-muted-foreground">
        A file in this project. Changes are committed to <b className="text-foreground">{branch}</b>.
      </span>
      {usedChip}
      {changed && (
        <Button size="xs" variant="outline" className="ml-auto" onClick={() => openContribute(file.id)}>
          <GitPullRequestArrowIcon /> Commit &amp; open PR
        </Button>
      )}
    </div>
  )
}

function StatusBar({ fileId }: { fileId: string | null }) {
  const doc = useStore((s) => (fileId ? s.docs[fileId] : undefined))
  const file = useFile(fileId)
  const active = useActiveRegion()
  const delta = doc ? doc.render.tokens - doc.originalRender.tokens : 0

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      {doc &&
        (doc.rendering ? (
          <span className="flex items-center gap-1">
            <LoaderIcon className="size-3 animate-spin" /> Rendering…
          </span>
        ) : doc.render.error ? (
          <span className="flex min-w-0 items-center gap-1 text-destructive">
            <TriangleAlertIcon className="size-3 shrink-0" />
            <span className="truncate">{doc.render.error}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <ZapIcon className="size-3 text-success" /> Rendered in {doc.render.ms} ms
          </span>
        ))}
      {doc && file?.isTpl && <span>{doc.render.regions.length} Liquid sections</span>}
      {doc && (
        <span title="Tokens in this file's output">
          {doc.render.tokens.toLocaleString()} tokens
          {delta !== 0 && (
            <b className={cn("ml-1", delta > 0 ? "text-warning" : "text-success")}>
              ({delta > 0 ? "+" : ""}
              {delta})
            </b>
          )}
        </span>
      )}
      {doc && Object.keys(doc.overrides).length > 0 && (
        <span className="text-warning">trying {Object.keys(doc.overrides).length} other value(s)</span>
      )}
      {active && (
        <span className="text-liquid">
          Editing <span className="font-mono">{active.kind === "output" ? `{{ ${active.label} }}` : `{% ${active.label} %}`}</span>{" "}
          — move the cursor out to re-render
        </span>
      )}
      <span className="ml-auto">{file?.isTpl ? "Markdown + Liquid" : "Markdown"}</span>
      <span>
        <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> open file
      </span>
    </div>
  )
}

export function EditorArea() {
  const activeId = useStore((s) => s.activeId)
  const tabs = useStore((s) => s.tabs)
  const docs = useStore((s) => s.docs)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const showOutput = useStore((s) => s.showOutput)
  const toggleOutput = useStore((s) => s.toggleOutput)
  const revert = useStore((s) => s.revert)
  const file = useFile(activeId)
  const doc = activeId ? docs[activeId] : undefined
  const changed = doc && doc.current !== doc.original

  return (
    <div className="flex h-full flex-col">
      <FileTabs />
      {file && doc ? (
        <>
          <div className="flex h-10 shrink-0 items-center gap-3 border-b px-4">
            <Breadcrumb file={file} />
            <div className="ml-auto flex items-center gap-1.5">
              {changed && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button size="icon-sm" variant="ghost" onClick={() => revert(file.id)}>
                        <RotateCcwIcon />
                      </Button>
                    }
                  />
                  <TooltipContent>Discard my changes to this file</TooltipContent>
                </Tooltip>
              )}
              {file.isTpl && (
                <ToggleGroup
                  value={[mode]}
                  onValueChange={(v) => v[0] && setMode(v[0] as Mode)}
                  variant="outline"
                  size="sm"
                >
                  <ToggleGroupItem value="rendered" className="px-2.5 text-xs">
                    <EyeIcon /> Rendered
                  </ToggleGroupItem>
                  <ToggleGroupItem value="source" className="px-2.5 text-xs">
                    <CodeIcon /> Source
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
              <Button size="icon-sm" variant={showOutput ? "secondary" : "ghost"} onClick={toggleOutput} title="Output pane">
                <PanelRightIcon />
              </Button>
            </div>
          </div>
          <OriginBanner file={file} />
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="62%" minSize="30%" className="bg-surface-editor">
                {tabs.map((id) =>
                  docs[id] ? <LiquidEditor key={id} fileId={id} visible={id === activeId} /> : null,
                )}
              </ResizablePanel>
              {showOutput && (
                <>
                  <ResizableHandle />
                  <ResizablePanel defaultSize="38%" minSize="20%">
                    <Inspector fileId={file.id} />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        </>
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          {activeId ? <LoaderIcon className="size-5 animate-spin" /> : "Open a file from the explorer."}
        </div>
      )}
      <StatusBar fileId={activeId} />
    </div>
  )
}
