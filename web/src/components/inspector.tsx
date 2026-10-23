// The right-hand panel of the editor: what the open file builds, the
// variables it renders with (and what-if values), where it is used, history.

import { useEffect, useMemo, useRef, useState } from "react"
import { diffLines } from "diff"
import DOMPurify from "dompurify"
import { marked } from "marked"
import {
  BoxesIcon,
  CircleAlertIcon,
  EyeIcon,
  FileDiffIcon,
  FileOutputIcon,
  FlaskConicalIcon,
  HistoryIcon,
  RotateCcwIcon,
  TextIcon,
  VariableIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Region, WorkspaceFile } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

export function useActiveRegion(): Region | null {
  const [active, setActive] = useState<Region | null>(null)
  useEffect(() => {
    const onActive = (e: Event) => setActive((e as CustomEvent<Region | null>).detail)
    window.addEventListener("sous-active-region", onActive)
    return () => window.removeEventListener("sous-active-region", onActive)
  }, [])
  return active
}

function RawOutput({ fileId }: { fileId: string }) {
  const doc = useStore((s) => s.docs[fileId])
  const jumpTo = useStore((s) => s.jumpTo)
  const active = useActiveRegion()
  const { output, segments, regions } = doc.render

  const pieces: { text: string; region?: number }[] = []
  let cursor = 0
  for (const seg of [...segments].sort((a, b) => a.start - b.start)) {
    if (seg.start < cursor) continue
    if (seg.start > cursor) pieces.push({ text: output.slice(cursor, seg.start) })
    if (seg.end > seg.start) pieces.push({ text: output.slice(seg.start, seg.end), region: seg.region })
    cursor = seg.end
  }
  pieces.push({ text: output.slice(cursor) })

  const pre = useRef<HTMLPreElement>(null)
  // Follow the editor: show the output of the section being edited, or at the top of the editor.
  useEffect(() => {
    pre.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [active])
  useEffect(() => {
    const onTop = (e: Event) => {
      const { fileId: id, index, atTop } = (e as CustomEvent<{ fileId: string; index: number; atTop: boolean }>).detail
      if (id !== fileId || !pre.current) return
      const viewport = pre.current.closest("[data-slot=scroll-area-viewport]") as HTMLElement | null
      if (!viewport) return
      if (atTop || index < 0) {
        viewport.scrollTo({ top: 0, behavior: "smooth" })
        return
      }
      const el = pre.current.querySelector(`[data-region="${index}"]`) as HTMLElement | null
      if (el)
        viewport.scrollTo({ top: el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 24, behavior: "smooth" })
    }
    window.addEventListener("sous-editor-top", onTop)
    return () => window.removeEventListener("sous-editor-top", onTop)
  }, [fileId])

  return (
    <pre ref={pre} className="relative px-4 pb-24 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
      {pieces.map((p, i) =>
        p.region === undefined ? (
          <PlainOutput key={i} text={p.text} />
        ) : (
          <span
            key={i}
            className="output-segment"
            data-region={p.region}
            data-active={active !== null && regions[p.region]?.from === active.from}
            title={regions[p.region]?.head}
            onClick={() => jumpTo(fileId, p.region!)}
          >
            {p.text}
          </span>
        ),
      )}
    </pre>
  )
}

const INCLUDE_LINE = /^@[~#a-zA-Z0-9_.${}*?[][\w\-/.:${}*?[\],!~#%+^()]*\.md\S*$/

/** Output text, with `@include` lines shown as what they are: placeholders the build fills in. */
function PlainOutput({ text }: { text: string }) {
  if (!text.includes("@")) return <span>{text}</span>
  const lines = text.split("\n")
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {INCLUDE_LINE.test(line.trim()) ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--cm-include)]/60 bg-muted/50 px-1.5 text-[11px] text-[var(--cm-include)]" title="sous build replaces this line with the file's contents">
              ⤷ {line.trim().replace(/^@/, "").split("/").slice(-2).join("/")}
              <span className="text-muted-foreground">included here at build</span>
            </span>
          ) : (
            line
          )}
          {i < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </>
  )
}

function stripFrontmatter(text: string): { front: string | null; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: null, body: text }
}

function PreviewOutput({ fileId }: { fileId: string }) {
  const output = useStore((s) => s.docs[fileId].render.output)
  const { front, body } = stripFrontmatter(output)
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(body, { async: false }) as string), [body])
  return (
    <div className="px-5 pb-24">
      {front && (
        <pre className="mb-4 rounded-lg border bg-muted/50 p-3 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {front}
        </pre>
      )}
      <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function DiffOutput({ fileId }: { fileId: string }) {
  const doc = useStore((s) => s.docs[fileId])
  const parts = useMemo(() => diffLines(doc.originalRender.output, doc.render.output), [doc.originalRender, doc.render])
  const changed = parts.some((p) => p.added || p.removed)
  if (!changed) {
    return (
      <div className="m-4 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        <FileDiffIcon className="mx-auto mb-2 size-5 opacity-60" />
        {doc.render.error ? "Can't compare until the template renders again." : "Nothing changes yet: the output is the same as before your edits."}
        <div className="mt-1 text-xs">Edit the template, or try another variable value, to see what changes for your agent.</div>
      </div>
    )
  }
  return (
    <div className="px-3 pb-24 font-mono text-[12px] leading-relaxed">
      {parts.map((p, i) => {
        if (!p.added && !p.removed) {
          const lines = p.value.split("\n")
          if (lines.length <= 7) return <div key={i} className="px-2 whitespace-pre-wrap text-muted-foreground">{p.value}</div>
          return (
            <div key={i} className="px-2 whitespace-pre-wrap text-muted-foreground">
              {lines.slice(0, 3).join("\n")}
              {"\n"}
              <span className="my-1 block rounded bg-muted/60 text-center text-[10px]">··· {lines.length - 6} unchanged lines ···</span>
              {lines.slice(-3).join("\n")}
            </div>
          )
        }
        return (
          <div key={i} className={cn("rounded px-2 whitespace-pre-wrap", p.added ? "diff-add" : "diff-del line-through decoration-destructive/40")}>
            {p.value}
          </div>
        )
      })}
    </div>
  )
}

function OutputTab({ fileId, file }: { fileId: string; file?: WorkspaceFile }) {
  const doc = useStore((s) => s.docs[fileId])
  const [view, setView] = useState<"raw" | "preview" | "diff">("raw")
  const delta = doc.render.tokens - doc.originalRender.tokens
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ToggleGroup value={[view]} onValueChange={(v) => v[0] && setView(v[0] as typeof view)} variant="outline" size="sm">
          <ToggleGroupItem value="raw" className="px-2 text-xs">
            <TextIcon /> Text
          </ToggleGroupItem>
          <ToggleGroupItem value="preview" className="px-2 text-xs">
            <EyeIcon /> Preview
          </ToggleGroupItem>
          <ToggleGroupItem value="diff" className="px-2 text-xs">
            <FileDiffIcon /> What changed
            {doc.render.output !== doc.originalRender.output && <span className="size-1.5 rounded-full bg-warning" />}
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-auto text-[11px] whitespace-nowrap text-muted-foreground" title="Tokens in this file's output (o200k)">
          {doc.render.tokens.toLocaleString()} tokens
          {delta !== 0 && (
            <span className={cn("ml-1 font-semibold", delta > 0 ? "text-warning" : "text-success")}>
              {delta > 0 ? "+" : ""}
              {delta}
            </span>
          )}
        </span>
      </div>
      {doc.render.error && (
        <div className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          <span>
            <b>Out of date.</b> The template doesn't render ({doc.render.error}), so this is the last good output.
          </span>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pt-3 pb-1 text-[11px] text-muted-foreground">
          {file?.outputs.length ? (
            <>
              Builds <span className="font-mono text-foreground">{file.outputs[0]}</span>
              {file.outputs.length > 1 && ` and ${file.outputs.length - 1} more`}.{" "}
            </>
          ) : null}
          {view === "raw" && "Click a highlighted piece to jump to the Liquid that wrote it."}
          {view === "preview" && "The output as markdown, the way a person would read it."}
          {view === "diff" &&
            (Object.keys(doc.overrides).length
              ? "What your edits and tried values change in the output."
              : "What your edits change in the output, compared with before you edited.")}
        </div>
        {view === "raw" && <RawOutput fileId={fileId} />}
        {view === "preview" && <PreviewOutput fileId={fileId} />}
        {view === "diff" && <DiffOutput fileId={fileId} />}
      </ScrollArea>
    </div>
  )
}

function VariablesTab({ fileId }: { fileId: string }) {
  const doc = useStore((s) => s.docs[fileId])
  const setOverride = useStore((s) => s.setOverride)
  const [filter, setFilter] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const used = useMemo(() => {
    const names = new Set<string>()
    for (const m of doc.current.matchAll(/\{\{-?\s*([A-Za-z_][\w]*)|\{%-?\s*(?:if|unless|elsif|case|for\s+\w+\s+in)\s+([A-Za-z_][\w]*)/g)) {
      names.add(m[1] ?? m[2])
    }
    return names
  }, [doc.current])
  const entries = Object.entries(doc.vars)
    .filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(filter.toLowerCase()))
    .sort(([a], [b]) => Number(used.has(b)) - Number(used.has(a)) || a.localeCompare(b))
  const overrideCount = Object.keys(doc.overrides).length

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter variables…" className="h-7 text-xs" />
        <p className="px-1 text-[11px] text-muted-foreground">
          Click a value to try another one. Only this preview changes; nothing is saved.
        </p>
        {overrideCount > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1 text-[11px] text-warning">
            <FlaskConicalIcon className="size-3.5" /> Previewing with {overrideCount} changed value{overrideCount === 1 ? "" : "s"}
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto h-5"
              onClick={() => Object.keys(doc.overrides).forEach((k) => setOverride(fileId, k, null))}
            >
              Reset all
            </Button>
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y text-xs">
          {entries.length === 0 && (
            <div className="p-6 text-center text-muted-foreground">
              No variable matches “{filter}”.{" "}
              <button className="text-brand underline" onClick={() => setFilter("")}>
                Clear
              </button>
            </div>
          )}
          {entries.map(([k, v]) => {
            const overridden = k in doc.overrides
            const value = overridden ? doc.overrides[k] : v
            const secret = v === "••••••"
            return (
              <div key={k} className={cn("px-3 py-1.5", overridden && "bg-warning/8")}>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-medium text-liquid">{k}</span>
                  {used.has(k) && (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                      used here
                    </Badge>
                  )}
                  {overridden && (
                    <button className="ml-auto text-muted-foreground hover:text-foreground" title="Back to the real value" onClick={() => setOverride(fileId, k, null)}>
                      <RotateCcwIcon className="size-3" />
                    </button>
                  )}
                </div>
                {editing === k ? (
                  <Input
                    autoFocus
                    defaultValue={value}
                    className="mt-1 h-6 font-mono text-xs"
                    onBlur={(e) => {
                      setEditing(null)
                      if (e.target.value !== v) setOverride(fileId, k, e.target.value)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                      if (e.key === "Escape") setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    disabled={secret}
                    onClick={() => setEditing(k)}
                    className={cn(
                      "block w-full truncate rounded px-1 -mx-1 text-left font-mono text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent",
                      overridden && "text-warning",
                    )}
                    title={secret ? "A secret: hidden, and can't be changed here" : value}
                  >
                    {value === "" ? <i>(empty)</i> : value}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

function UsedByTab({ file }: { file?: WorkspaceFile }) {
  const build = useStore((s) => s.build)
  const files = useStore((s) => s.workspace?.files ?? [])
  const open = useStore((s) => s.open)
  if (!file) return null
  if (!build) return <p className="p-4 text-xs text-muted-foreground">Working out where this file is used…</p>
  const outputs = build.outputs.filter((o) => o.sources.includes(file.id))
  const total = outputs.reduce((n, o) => n + o.tokens, 0)
  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">
          {outputs.length === 0
            ? "No output includes this file, so editing it changes nothing an agent reads."
            : `${outputs.length} output file${outputs.length === 1 ? "" : "s"} include this file${file.role === "partial" ? ", so an edit here changes all of them" : ""}. Together they hold ${total.toLocaleString()} tokens.`}
        </p>
        {outputs.map((o) => {
          const entry = files.find((f) => f.id === o.entryId)
          return (
            <div key={o.output} className="rounded-lg border bg-card p-2.5">
              <div className="flex items-center gap-2">
                <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{o.output}</span>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{o.tokens.toLocaleString()} tok</span>
              </div>
              {entry && entry.id !== file.id && (
                <button onClick={() => open(entry.id)} className="mt-1 block truncate pl-5.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
                  built from {entry.display}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
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
    <div className="space-y-3 p-3 text-xs">
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

export function Inspector({ fileId }: { fileId: string }) {
  const doc = useStore((s) => s.docs[fileId])
  const files = useStore((s) => s.workspace?.files)
  const build = useStore((s) => s.build)
  const file = useMemo(() => files?.find((f) => f.id === fileId), [files, fileId])
  if (!doc) return null
  const usedCount = build?.outputs.filter((o) => o.sources.includes(fileId)).length
  const failed = build?.outputs.find((o) => o.entryId === fileId && o.status === "failed")
  const overrideCount = Object.keys(doc.overrides).length

  return (
    <Tabs defaultValue="output" className="h-full gap-0">
      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="output">
            <EyeIcon /> Result
          </TabsTrigger>
          <TabsTrigger value="vars">
            <VariableIcon /> Variables
            {overrideCount > 0 && <span className="size-1.5 rounded-full bg-warning" />}
          </TabsTrigger>
          <TabsTrigger value="used">
            <BoxesIcon /> Used by
            {usedCount !== undefined && <span className="text-[10px] text-muted-foreground">{usedCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="history" title="History of this file (mock)" aria-label="History">
            <HistoryIcon />
          </TabsTrigger>
        </TabsList>
      </div>
      {failed && (
        <div className="flex gap-2 border-b bg-destructive/8 px-3 py-2 text-[11px] text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">
            <b>sous build fails for this file:</b> {failed.error}
          </span>
        </div>
      )}
      <TabsContent value="output" className="min-h-0">
        <OutputTab fileId={fileId} file={file} />
      </TabsContent>
      <TabsContent value="vars" className="min-h-0">
        <VariablesTab fileId={fileId} />
      </TabsContent>
      <TabsContent value="used" className="min-h-0">
        <UsedByTab file={file} />
      </TabsContent>
      <TabsContent value="history" className="min-h-0">
        <MockHistory file={file} />
      </TabsContent>
    </Tabs>
  )
}
