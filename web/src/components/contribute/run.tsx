// The run (simulated, with the real commands in a disclosure) and the result.

import { useEffect, useMemo, useState } from "react"
import { ArrowRightIcon, CheckIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, GitMergeIcon, HardDriveIcon, ListChecksIcon, LoaderIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { WorkspaceFile } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { Proposal } from "@/mock/data"
import type { Group, Step } from "./model"
import { RepoAvatar } from "./avatar"

const STYLE = `
@keyframes sous-draw { to { stroke-dashoffset: 0 } }
@keyframes sous-pop { 0% { transform: scale(.6); opacity: 0 } 60% { transform: scale(1.08); opacity: 1 } 100% { transform: scale(1) } }
@keyframes sous-ring { 0% { transform: scale(.8); opacity: .7 } 100% { transform: scale(1.9); opacity: 0 } }
@keyframes sous-fall { 0% { transform: translate(0,0) rotate(0); opacity: 1 } 100% { transform: translate(var(--dx), 260px) rotate(var(--r)); opacity: 0 } }
@keyframes sous-rise { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
`

function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 34 }, (_, i) => ({
        left: 50 + (Math.random() - 0.5) * 40,
        dx: `${(Math.random() - 0.5) * 380}px`,
        r: `${Math.random() * 720 - 360}deg`,
        delay: Math.random() * 0.25,
        color: ["var(--brand)", "var(--success)", "var(--cm-liquid)", "var(--brand-2)", "var(--warning)"][i % 5],
        w: 5 + Math.random() * 4,
      })),
    [],
  )
  return (
    <div className="pointer-events-none absolute inset-x-0 top-6 h-0">
      {bits.map((b, i) => (
        <span
          key={i}
          className="absolute rounded-[1px]"
          style={
            {
              left: `${b.left}%`,
              width: b.w,
              height: b.w * 0.45,
              background: b.color,
              "--dx": b.dx,
              "--r": b.r,
              animation: `sous-fall 1.5s cubic-bezier(.2,.6,.4,1) ${b.delay}s forwards`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

function BigCheck() {
  return (
    <div className="relative grid size-16 place-items-center">
      <span className="absolute inset-0 rounded-full bg-success/40" style={{ animation: "sous-ring 1s ease-out .2s forwards", opacity: 0 }} />
      <span className="absolute inset-0 rounded-full bg-success shadow-[0_8px_30px_-6px_var(--success)]" style={{ animation: "sous-pop .45s ease-out forwards" }} />
      <svg viewBox="0 0 24 24" className="relative size-8 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: "sous-draw .4s ease-out .3s forwards" }} />
      </svg>
    </div>
  )
}

function StepList({ steps, at, collapsed }: { steps: Step[]; at: number; collapsed?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(!collapsed)
  if (!expanded)
    return (
      <button onClick={() => setExpanded(true)} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
        <ListChecksIcon className="size-3.5 text-success" /> {steps.length} steps done <ChevronRightIcon className="size-3" />
      </button>
    )
  return (
    <ol className="relative space-y-1">
      {steps.map((s, i) => {
        const done = i < at
        const active = i === at
        return (
          <li key={i} className={cn("rounded-lg transition-colors", active && "bg-muted/50")}>
            <button className="flex w-full items-start gap-3 px-3 py-2 text-left" onClick={() => setOpen(open === i ? null : i)}>
              <span
                className={cn(
                  "mt-px grid size-5 shrink-0 place-items-center rounded-full border transition-all duration-300",
                  done && "border-success bg-success text-white",
                  active && "border-brand text-brand",
                  !done && !active && "text-muted-foreground/40",
                )}
              >
                {done ? <CheckIcon className="size-3" strokeWidth={3} /> : active ? <LoaderIcon className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[13px]", !done && !active && "text-muted-foreground")}>{done ? s.done : s.label}</span>
              </span>
              <ChevronRightIcon className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open === i && "rotate-90")} />
            </button>
            {open === i && (
              <pre className="mx-3 mb-2 ml-11 overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {s.command}
              </pre>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function NextUp({ next }: { next: { label: string; go: () => void } }) {
  return (
    <Button variant="outline" onClick={next.go} className="group">
      Next: {next.label} <ArrowRightIcon className="transition-transform group-hover:translate-x-0.5" />
    </Button>
  )
}

export function RunView(props: {
  group: Group
  steps: Step[]
  files: WorkspaceFile[]
  title: string
  body: string
  draft: boolean
  branch: string
  headRepo: string
  baseBranch: string
  recipes: { name: string; from: string; to: string }[]
  addTo?: Proposal
  onDone: (p: Proposal | null) => void
  next?: { label: string; go: () => void }
}) {
  const { group, steps, files, title, body, draft, branch, headRepo, recipes, addTo, onDone, next } = props
  const [at, setAt] = useState(0)
  const [result, setResult] = useState<Proposal | null>(null)
  const [keep, setKeep] = useState<"keep" | "released">("keep")
  const [saved, setSaved] = useState(false)
  const finished = at >= steps.length

  useEffect(() => {
    if (finished) return
    const t = window.setTimeout(() => setAt((n) => n + 1), steps[at].ms)
    return () => window.clearTimeout(t)
  }, [at, finished, steps])

  useEffect(() => {
    if (!finished || saved) return
    setSaved(true)
    const ids = files.map((f) => f.id)
    if (group.kind === "project") {
      // Saved (simulated): what's on disk is now your edit.
      useStore.setState((s) => {
        const docs = { ...s.docs }
        for (const id of ids) if (docs[id]) docs[id] = { ...docs[id], original: docs[id].current, originalRender: docs[id].render }
        return { docs }
      })
      onDone(null)
      return
    }
    if (addTo) {
      const updated: Proposal = { ...addTo, files: addTo.files + files.length, fileIds: [...new Set([...(addTo.fileIds ?? []), ...ids])], title, description: body }
      useStore.setState((s) => {
        const docs = { ...s.docs }
        for (const id of ids) if (docs[id]) docs[id] = { ...docs[id], proposedIn: addTo.id, proposedContent: docs[id].current }
        return { proposals: s.proposals.map((p) => (p.id === addTo.id ? updated : p)), docs }
      })
      setResult(updated)
      onDone(updated)
      return
    }
    const proposal: Proposal = {
      id: `p-${Date.now()}`,
      repo: group.key,
      number: 231 + Math.floor(Math.random() * 12),
      title,
      branch,
      recipes: group.kind === "pr" ? recipes : [],
      files: files.length,
      stage: "opened",
      openedAt: "just now",
      draft,
      kind: group.kind === "core" ? "core" : "recipe",
      head: headRepo,
      fileIds: ids,
      keptLocal: true,
      description: body,
    }
    useStore.getState().addProposal(proposal, ids)
    setResult(proposal)
    onDone(proposal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished])

  const chooseBuild = (v: "keep" | "released") => {
    setKeep(v)
    if (!result) return
    useStore.setState((s) => ({ proposals: s.proposals.map((p) => (p.id === result.id ? { ...p, keptLocal: v === "keep" } : p)) }))
    if (v === "released") toast("Your build uses the released recipes again", { description: "Your edits come back when the release that carries them is out. (Simulated.)" })
  }

  const url = result ? `https://${group.host ?? "github.com"}/${group.title}/pull/${result.number}` : ""

  return (
    <div className="space-y-6 px-7 pt-6 pb-8">
      <style>{STYLE}</style>
      {!finished || group.kind === "project" ? (
        <>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              {finished ? (
                <>
                  <CheckIcon className="size-5 text-success" /> Saved
                </>
              ) : group.kind === "project" ? (
                "Saving…"
              ) : addTo ? (
                `Adding to #${addTo.number}…`
              ) : (
                `Proposing to ${group.title}…`
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="mr-1.5 rounded bg-muted px-1 py-px text-[10px] tracking-wide uppercase">simulated</span>
              Nothing is written or sent in this proof of concept. Click a step to see what sous would run.
            </p>
          </div>
          <StepList steps={steps} at={at} />
          {finished && next && <NextUp next={next} />}
        </>
      ) : (
        <div className="relative space-y-6" style={{ animation: "sous-rise .35s ease-out" }}>
          <Confetti />
          <div className="flex flex-col items-center pt-2 text-center">
            <BigCheck />
            <div className="mt-4 text-sm text-muted-foreground">{addTo ? "Pull request updated" : result?.draft ? "Draft pull request opened" : "Pull request opened"}</div>
            <div className="mt-1 flex items-center gap-3">
              <RepoAvatar owner={group.owner} className="size-9" />
              <div className="text-left">
                <div className="text-3xl leading-none font-bold tracking-tight">#{result?.number}</div>
                <div className="mt-1 text-xs text-muted-foreground">{group.title}</div>
              </div>
            </div>
            <div className="mt-3 max-w-lg text-[15px] font-medium">{result?.title}</div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              {headRepo}:{branch} → {group.title}:{props.baseBranch}
            </div>
            {recipes.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                {recipes.map((r) => (
                  <span key={r.name} className="rounded-full border bg-recipe/10 px-2 py-0.5 font-mono text-[10.5px] text-recipe">
                    {r.name} {r.to}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <Button
                className="bg-brand text-white hover:bg-brand/90"
                onClick={() => toast("Simulated: this pull request doesn't exist.", { description: url })}
              >
                View on GitHub <ExternalLinkIcon />
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(url).catch(() => {})
                  toast.success("Link copied", { description: "Simulated link." })
                }}
              >
                <CopyIcon /> Copy link
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  useStore.getState().closeContribute()
                  useStore.getState().setPage("proposals")
                }}
              >
                Track it in Proposals
              </Button>
            </div>
            <span className="mt-2 rounded bg-muted px-1 py-px text-[10px] tracking-wide text-muted-foreground uppercase">simulated</span>
          </div>

          {!addTo && (
            <div className="rounded-xl border bg-card p-4">
              <div className="text-[13px] font-semibold">Your build, until this is released</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    {
                      key: "keep",
                      icon: HardDriveIcon,
                      title: "Keep my edits on this machine",
                      text: "Sous stays linked to the checkout, so your agent gets your edit now. Builds say so. Teammates and CI don't get it.",
                    },
                    {
                      key: "released",
                      icon: RotateCcwIcon,
                      title: "Go back to the released version",
                      text: "Your edits leave your build until the release that carries them is out.",
                    },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.key}
                    onClick={() => chooseBuild(o.key)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-all",
                      keep === o.key ? "border-brand bg-brand/6 ring-1 ring-brand" : "hover:bg-muted/40",
                    )}
                  >
                    <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", keep === o.key && "border-brand")}>
                      {keep === o.key && <span className="size-2 rounded-full bg-brand" />}
                    </span>
                    <span>
                      <span className="flex items-center gap-1.5 text-[13px] font-medium">
                        <o.icon className="size-3.5 text-muted-foreground" /> {o.title}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{o.text}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitMergeIcon className="size-3.5" /> When it's merged and released, sous serve offers to move this project to the new version.
              </p>
            </div>
          )}

          <div className="flex items-center gap-4">
            <StepList steps={steps} at={at} collapsed />
            {next && <div className="ml-auto"><NextUp next={next} /></div>}
          </div>
        </div>
      )}
    </div>
  )
}
