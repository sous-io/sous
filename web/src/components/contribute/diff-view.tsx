import { useEffect, useMemo, useRef, useState } from "react"
import { structuredPatch } from "diff"
import { BotIcon, ChevronRightIcon, CodeIcon, GitCompareArrowsIcon } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import type { WorkspaceFile } from "@/lib/api"
import type { OpenDoc } from "@/lib/store"
import { cn } from "@/lib/utils"
import { lineStats, type MergeResult } from "./model"

export function DiffView({ a, b, empty = "No difference." }: { a: string; b: string; empty?: string }) {
  const patch = useMemo(() => structuredPatch("a", "b", a, b, "", "", { context: 2 }), [a, b])
  if (patch.hunks.length === 0)
    return <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{empty}</div>
  return (
    <div className="overflow-x-auto rounded-md border bg-background font-mono text-[11.5px] leading-5">
      {patch.hunks.map((h, i) => (
        <div key={i} className={cn(i > 0 && "border-t border-dashed")}>
          <div className="bg-muted/50 px-3 text-[10.5px] text-muted-foreground">
            lines {h.newStart}–{h.newStart + Math.max(h.newLines - 1, 0)}
          </div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={cn("flex px-3 whitespace-pre-wrap", l.startsWith("+") && "diff-add", l.startsWith("-") && "diff-del")}
            >
              <span
                className={cn(
                  "mr-2 inline-block w-2 shrink-0 select-none",
                  l.startsWith("+") ? "text-success" : l.startsWith("-") ? "text-destructive" : "text-muted-foreground/50",
                )}
              >
                {l[0] === " " ? "" : l[0]}
              </span>
              <span className="min-w-0 break-words">{l.slice(1) || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

type Tab = "upstream" | "pinned" | "agent"

export function FileChange({
  file,
  doc,
  merge,
  included,
  onToggle,
  defaultOpen,
  baseBranch,
  canExclude,
}: {
  file: WorkspaceFile
  doc: OpenDoc
  merge: MergeResult
  included: boolean
  onToggle: (v: boolean) => void
  defaultOpen: boolean
  baseBranch: string
  canExclude: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasUpstream = merge.state !== "no-upstream" && file.origin.kind === "recipe"
  const [tab, setTabState] = useState<Tab>(hasUpstream ? "upstream" : "pinned")
  const chosen = useRef(false)
  const setTab = (t: Tab) => {
    chosen.current = true
    setTabState(t)
  }
  // Upstream arrives a moment after the dialog opens: show it unless you picked a tab.
  useEffect(() => {
    if (!chosen.current) setTabState(hasUpstream ? "upstream" : "pinned")
  }, [hasUpstream])
  const s = lineStats(doc.original, doc.current)
  const version = file.origin.kind === "recipe" ? file.origin.version : null

  return (
    <div className={cn("rounded-lg border bg-card transition-opacity", !included && "opacity-55")}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox
          checked={included}
          onCheckedChange={(v) => onToggle(!!v)}
          disabled={!canExclude && included}
          aria-label={`Include ${file.display}`}
        />
        <button onClick={() => setOpen(!open)} className="group flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="truncate font-mono text-xs">
            <span className="text-muted-foreground">{file.display.split("/").slice(0, -1).join("/")}/</span>
            <span className="font-medium text-foreground">{file.display.split("/").pop()}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px]">
            {merge.state === "clean" && (
              <span className="rounded-full bg-success/12 px-1.5 py-px font-sans text-[10px] text-success">merged onto {baseBranch}</span>
            )}
            {merge.state === "conflict" && (
              <span className="rounded-full bg-warning/15 px-1.5 py-px font-sans text-[10px] text-warning">conflicts with {baseBranch}</span>
            )}
            <span className="text-success">+{s.added}</span>
            <span className="text-destructive">−{s.removed}</span>
          </span>
        </button>
      </div>
      {!included && (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          Left out. It stays as an unsent edit in sous serve.
        </div>
      )}
      {open && included && (
        <div className="space-y-2 border-t px-3 pt-2 pb-3">
          <div className="flex items-center gap-1">
            {(
              [
                hasUpstream && { key: "upstream", icon: GitCompareArrowsIcon, label: `Against ${baseBranch}`, hint: "what reviewers will see" },
                { key: "pinned", icon: CodeIcon, label: version ? `Against ${version}, the one you use` : "Against the file on disk", hint: "" },
                { key: "agent", icon: BotIcon, label: "What your agent will read", hint: "rendered output" },
              ].filter(Boolean) as { key: Tab; icon: typeof CodeIcon; label: string; hint: string }[]
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors",
                  tab === t.key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-3.5" /> {t.label}
              </button>
            ))}
          </div>
          {tab === "upstream" && (
            <>
              {merge.state === "same" && (
                <p className="text-[11px] text-muted-foreground">
                  This file is the same on {baseBranch} as in {version}, so your edit applies as it is.
                </p>
              )}
              {merge.state === "clean" && (
                <p className="text-[11px] text-muted-foreground">
                  {baseBranch} changed this file since {version}. Your edit was merged onto it, and this is the result.
                </p>
              )}
              {merge.state === "conflict" && (
                <p className="text-[11px] text-warning">
                  {baseBranch} changed the same lines you did. Shown against {version}; a conflict editor would open here.
                </p>
              )}
              <DiffView a={merge.state === "conflict" ? doc.original : (merge.upstream ?? doc.original)} b={merge.text} />
            </>
          )}
          {tab === "pinned" && <DiffView a={doc.original} b={doc.current} />}
          {tab === "agent" && (
            <DiffView
              a={doc.originalRender.output}
              b={doc.render.output}
              empty="The rendered output is the same. (A Liquid-only change, or the render hasn't caught up.)"
            />
          )}
        </div>
      )}
    </div>
  )
}
