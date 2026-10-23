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
    <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b bg-muted/30">
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
              activeId === id ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/60",
            )}
          >
            {f?.isTpl ? (
              <FileCode2Icon className="size-3.5 text-[var(--cm-liquid)]" />
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
                <span className="size-2 rounded-full bg-amber-500 group-hover:hidden" />
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
  const branch = useStore((s) => s.workspace?.branch)
  const openContribute = useStore((s) => s.openContribute)
  const changed = doc && doc.current !== doc.original
  const o = file.origin

  if (doc?.proposedIn) {
    const proposal = useStore.getState().proposals.find((p) => p.id === doc.proposedIn)
    return (
      <div className="flex items-center gap-2 border-b bg-emerald-500/8 px-4 py-1.5 text-xs">
        <GitPullRequestArrowIcon className="size-3.5 text-emerald-500" />
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
      <div className="flex items-center gap-2 border-b bg-sky-500/6 px-4 py-1.5 text-xs">
        <Badge variant="outline" className="h-5 border-sky-500/40 text-sky-600 dark:text-sky-400">
          recipe
        </Badge>
        <span className="truncate text-muted-foreground">
          From <b className="text-foreground">{o.namespace}/{o.recipe}</b> {o.version} in {o.owner}/{o.repo}.{" "}
          {changed ? "You changed it; send the change upstream when you're ready." : "Edit freely: sous keeps a copy for you to propose upstream."}
        </span>
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
      <div className="flex items-center gap-2 border-b bg-[var(--cm-liquid-bg)] px-4 py-1.5 text-xs">
        <SparklesIcon className="size-3.5 text-[var(--cm-liquid)]" />
        <span className="text-muted-foreground">
          A sample template, rendered with <b className="text-foreground">this project's real variables</b>. Click a
          highlighted section to edit its Liquid; move out of it to re-render.
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-xs">
      <Badge variant="outline" className="h-5">
        project
      </Badge>
      <span className="text-muted-foreground">
        A file in this project. Changes are committed to <b className="text-foreground">{branch}</b>.
      </span>
      {changed && (
        <Button size="xs" variant="outline" className="ml-auto" onClick={() => openContribute(file.id)}>
          <GitPullRequestArrowIcon /> Commit &amp; open PR
        </Button>
      )}
    </div>
  )
}

function OutputPane({ fileId }: { fileId: string }) {
  const doc = useStore((s) => s.docs[fileId])
  const jumpTo = useStore((s) => s.jumpTo)
  const file = useFile(fileId)
  const [active, setActive] = useState<Region | null>(null)
  const [filter, setFilter] = useState("")

  useEffect(() => {
    const onActive = (e: Event) => setActive((e as CustomEvent<Region | null>).detail)
    window.addEventListener("sous-active-region", onActive)
    return () => window.removeEventListener("sous-active-region", onActive)
  }, [])

  if (!doc) return null
  const { output, segments, regions } = doc.render

  // Split the output into plain text and clickable pieces that came from a Liquid section.
  const pieces: { text: string; region?: number }[] = []
  let cursor = 0
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    if (seg.start < cursor) continue
    if (seg.start > cursor) pieces.push({ text: output.slice(cursor, seg.start) })
    if (seg.end > seg.start) pieces.push({ text: output.slice(seg.start, seg.end), region: seg.region })
    cursor = seg.end
  }
  pieces.push({ text: output.slice(cursor) })

  const vars = Object.entries(doc.vars).filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <Tabs defaultValue="output" className="h-full gap-0">
      <div className="flex h-9 items-center border-b px-2">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="output">
            <EyeIcon /> Output
          </TabsTrigger>
          <TabsTrigger value="vars">Variables</TabsTrigger>
          <TabsTrigger value="history">
            <HistoryIcon /> History
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="output" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="px-4 pt-3 pb-1 text-[11px] text-muted-foreground">
            {file?.outputs.length ? (
              <>
                Builds <span className="font-mono text-foreground">{file.outputs[0]}</span>
                {file.outputs.length > 1 && ` and ${file.outputs.length - 1} more`}.{" "}
              </>
            ) : null}
            Click a highlighted piece to jump to the Liquid that wrote it.
          </div>
          <pre className="px-4 pb-24 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {pieces.map((p, i) =>
              p.region === undefined ? (
                <span key={i}>{p.text}</span>
              ) : (
                <span
                  key={i}
                  className="output-segment"
                  data-active={
                    active !== null && regions[p.region]?.from === active.from && regions[p.region]?.to === active.to
                  }
                  title={`${regions[p.region]?.kind === "output" ? "{{ " : "{% "}${regions[p.region]?.label}${regions[p.region]?.kind === "output" ? " }}" : " %}"}`}
                  onClick={() => jumpTo(fileId, p.region!)}
                >
                  {p.text}
                </span>
              ),
            )}
          </pre>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="vars" className="min-h-0">
        <div className="border-b p-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter variables…" className="h-7 text-xs" />
        </div>
        <ScrollArea className="h-[calc(100%-45px)]">
          <div className="divide-y text-xs">
            {vars.map(([k, v]) => (
              <div key={k} className="px-3 py-1.5">
                <div className="font-mono font-medium text-[var(--cm-liquid)]">{k}</div>
                <div className="truncate font-mono text-muted-foreground" title={v}>
                  {v === "" ? <i>(empty)</i> : v}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="history" className="min-h-0 p-3">
        <MockHistory file={file} />
      </TabsContent>
    </Tabs>
  )
}

function MockHistory({ file }: { file?: WorkspaceFile }) {
  const items =
    file?.origin.kind === "recipe"
      ? [
          { v: file.origin.version, what: "Released", when: "2 weeks ago" },
          { v: "", what: "Reworded the opening paragraph (#188)", when: "3 weeks ago" },
          { v: "", what: "Added an example for nested includes (#171)", when: "1 month ago" },
        ]
      : [
          { v: "", what: "Last commit touching this file", when: "yesterday" },
          { v: "", what: "Created", when: "2 months ago" },
        ]
  return (
    <div className="space-y-3 text-xs">
      <Badge variant="outline" className="text-[10px]">
        mock
      </Badge>
      {items.map((it, i) => (
        <div key={i} className="flex gap-2">
          <div className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/50" />
          <div>
            <div>
              {it.v && <b className="mr-1">{it.v}</b>}
              {it.what}
            </div>
            <div className="text-muted-foreground">{it.when}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function StatusBar({ fileId }: { fileId: string | null }) {
  const doc = useStore((s) => (fileId ? s.docs[fileId] : undefined))
  const file = useFile(fileId)
  const [active, setActive] = useState<Region | null>(null)

  useEffect(() => {
    const onActive = (e: Event) => setActive((e as CustomEvent<Region | null>).detail)
    window.addEventListener("sous-active-region", onActive)
    return () => window.removeEventListener("sous-active-region", onActive)
  }, [])

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t bg-muted/40 px-3 text-[11px] text-muted-foreground">
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
            <ZapIcon className="size-3 text-emerald-500" /> Rendered in {doc.render.ms} ms
          </span>
        ))}
      {doc && file?.isTpl && <span>{doc.render.regions.length} Liquid sections</span>}
      {active && (
        <span className="text-[var(--cm-liquid)]">
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
              <ResizablePanel defaultSize="62%" minSize="30%">
                {tabs.map((id) =>
                  docs[id] ? <LiquidEditor key={id} fileId={id} visible={id === activeId} /> : null,
                )}
              </ResizablePanel>
              {showOutput && (
                <>
                  <ResizableHandle />
                  <ResizablePanel defaultSize="38%" minSize="20%">
                    <OutputPane fileId={file.id} />
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
