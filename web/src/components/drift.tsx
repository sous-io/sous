// Hand edits to a built output: someone (often an agent) edited CLAUDE.md or a
// SKILL.md directly, and the next build would throw that edit away. This finds
// each edit and moves it into the template, where it survives and can be sent
// upstream.

import { useEffect, useMemo, useState } from "react"
import { diffLines } from "diff"
import { ArrowDownToLineIcon, CheckIcon, CopyIcon, CrosshairIcon, HandIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, type Drift } from "@/lib/api"
import { useTour } from "@/components/tour"
import { useStore } from "@/lib/store"

type Edit = {
  before: string
  after: string
  /** Where the old text is in the template, when it is plain text there. */
  at: number | null
  /** The Liquid section that wrote the old text, when one did. */
  region: number | null
}

function findEdits(drift: Drift, source: string, outputSegments: { start: number; end: number; region: number }[]): Edit[] {
  const edits: Edit[] = []
  const parts = diffLines(drift.built, drift.disk)
  let offset = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.removed) {
      const next = parts[i + 1]
      const after = next?.added ? next.value : ""
      if (next?.added) i++
      const before = part.value
      const seg = outputSegments.find((s) => offset < s.end && offset + before.length > s.start)
      const trimmed = before.replace(/\n$/, "")
      const first = source.indexOf(trimmed)
      const unique = first !== -1 && source.indexOf(trimmed, first + 1) === -1
      edits.push({ before, after, at: unique ? first : null, region: seg ? seg.region : null })
      offset += before.length
    } else if (part.added) {
      edits.push({ before: "", after: part.value, at: null, region: null })
    } else {
      offset += part.value.length
    }
  }
  return edits
}

export function useDrift(fileId: string | null) {
  const [drift, setDrift] = useState<Drift | null>(null)
  const build = useStore((s) => s.build)
  useEffect(() => {
    setDrift(null)
    if (!fileId || !build) return
    api.drift(fileId).then((r) => setDrift(r.drift)).catch(() => {})
  }, [fileId, build])
  return drift
}

function tourSeen(): boolean {
  try {
    return localStorage.getItem("sous-tour-done") === "1" || localStorage.getItem("sous-tip-seen") === "1"
  } catch {
    return true
  }
}

export function DriftBanner({ fileId }: { fileId: string }) {
  const tourStep = useTour((s) => s.step)
  const drift = useDrift(fileId)
  const doc = useStore((s) => s.docs[fileId])
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const edits = useMemo(
    () => (drift && doc ? findEdits(drift, doc.original, doc.originalRender.segments) : []),
    [drift, doc?.original, doc?.originalRender],
  )
  if (!drift || dismissed || edits.length === 0) return null
  // On the sample, the (simulated) hand edits wait for the tour's step about them, or for the tour to be done.
  if (drift.simulated && ((tourStep !== null && tourStep < 5) || (tourStep === null && !tourSeen()))) return null

  return (
    <>
      <div className="flex items-center gap-2 border-b bg-warning/10 px-4 py-1.5 text-xs" data-tour="drift">
        <HandIcon className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate">
          <b>
            {drift.output} was edited by hand ({edits.length} change{edits.length === 1 ? "" : "s"}).
          </b>{" "}
          <span className="text-muted-foreground">The next build would throw {edits.length === 1 ? "it" : "them"} away.</span>
        </span>
        {drift.simulated && (
          <Badge variant="outline" className="h-4 shrink-0 text-[9px]">
            simulated
          </Badge>
        )}
        <Button size="xs" className="ml-auto shrink-0" onClick={() => setOpen(true)}>
          <ArrowDownToLineIcon /> Keep them in the template
        </Button>
        <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setDismissed(true)}>
          Ignore
        </Button>
      </div>
      <DriftDialog open={open} onClose={() => setOpen(false)} fileId={fileId} drift={drift} edits={edits} onDone={() => setDismissed(true)} />
    </>
  )
}

function DriftDialog({
  open,
  onClose,
  fileId,
  drift,
  edits,
  onDone,
}: {
  open: boolean
  onClose: () => void
  fileId: string
  drift: Drift
  edits: Edit[]
  onDone: () => void
}) {
  const doc = useStore((s) => s.docs[fileId])
  const edit = useStore((s) => s.edit)
  const jumpTo = useStore((s) => s.jumpTo)
  const [applied, setApplied] = useState<Set<number>>(new Set())

  const apply = (indexes: number[]) => {
    let text = useStore.getState().docs[fileId].current
    const done = new Set(applied)
    for (const i of indexes) {
      const e = edits[i]
      if (e.at === null || done.has(i)) continue
      const before = e.before.replace(/\n$/, "")
      const after = e.after.replace(/\n$/, "")
      if (!text.includes(before)) continue
      text = text.replace(before, after)
      done.add(i)
    }
    edit(fileId, text)
    setApplied(done)
    toast.success(`Moved ${done.size - applied.size} edit${done.size - applied.size === 1 ? "" : "s"} into the template`)
  }
  const placeable = edits.map((e, i) => (e.at !== null ? i : -1)).filter((i) => i >= 0)
  const regions = doc?.originalRender.regions ?? []

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandIcon className="size-4 text-warning" /> Hand edits to {drift.output}
          </DialogTitle>
          <DialogDescription>
            sous writes this file from a template, so edits made to the file itself are lost at the next build. Move each one into the
            template instead; from there you can keep it, or send it upstream.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh]">
          <div className="space-y-3 pr-3">
            {edits.map((e, i) => (
              <div key={i} className="rounded-lg border bg-card">
                <div className="space-y-px p-2 font-mono text-[12px]">
                  {e.before && <div className="diff-del rounded px-2 whitespace-pre-wrap">− {e.before.replace(/\n$/, "")}</div>}
                  {e.after && <div className="diff-add rounded px-2 whitespace-pre-wrap">+ {e.after.replace(/\n$/, "")}</div>}
                </div>
                <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
                  {applied.has(i) ? (
                    <span className="flex items-center gap-1 text-success">
                      <CheckIcon className="size-3.5" /> In the template
                    </span>
                  ) : e.at !== null ? (
                    <>
                      <span className="text-muted-foreground">
                        {e.region !== null ? (
                          <>
                            It's plain text inside <code className="rounded bg-liquid-soft px-1 text-liquid">{regions[e.region]?.head}</code>, so
                            it can be changed there.
                          </>
                        ) : (
                          "It's plain text in the template, so it can be changed there directly."
                        )}
                      </span>
                      <Button size="xs" className="ml-auto" onClick={() => apply([i])}>
                        <ArrowDownToLineIcon /> Move into template
                      </Button>
                    </>
                  ) : e.region !== null ? (
                    <>
                      <span className="text-muted-foreground">
                        Liquid wrote this text: <code className="rounded bg-liquid-soft px-1 text-liquid">{regions[e.region]?.head}</code>. Change it
                        there.
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => {
                          onClose()
                          jumpTo(fileId, e.region!)
                        }}
                      >
                        <CrosshairIcon /> Open that section
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">sous can't tell where this goes in the template.</span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => {
                          navigator.clipboard?.writeText(e.after).catch(() => {})
                          toast.success("Copied the edited text")
                        }}
                      >
                        <CopyIcon /> Copy it
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {placeable.length} of {edits.length} can be moved automatically.
          </span>
          <Button
            className="ml-auto"
            disabled={placeable.every((i) => applied.has(i))}
            onClick={() => {
              apply(placeable)
            }}
          >
            <ArrowDownToLineIcon /> Move {placeable.length === edits.length ? "all" : "what fits"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onDone()
              onClose()
            }}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
