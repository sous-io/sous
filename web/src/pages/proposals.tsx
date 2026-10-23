// MOCK: tracks proposals made from the GUI, from "opened" to "released", and
// offers the update once the new version is out. A real version would read the
// state with `sous repo submit --status` (gh pr view underneath).

import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestDraftIcon,
  HardDriveIcon,
  MessageSquareIcon,
  PencilLineIcon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useEffect, useRef } from "react"
import { RepoAvatar } from "@/components/contribute/avatar"
import { useJustSent } from "@/components/contribute/model"
import { MyPullRequests } from "@/components/proposals/my-prs"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { Proposal, ProposalStage } from "@/mock/data"

const STAGES: { key: ProposalStage; label: string }[] = [
  { key: "opened", label: "Opened" },
  { key: "checks", label: "Checks pass" },
  { key: "review", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "released", label: "Released" },
]

function Timeline({ stage, draft }: { stage: ProposalStage; draft: boolean }) {
  // Steps up to and including the current stage are done; once released, all of them are.
  const at = STAGES.findIndex((s) => s.key === stage)
  return (
    <div className="flex items-center">
      {STAGES.map((s, i) => {
        const done = i <= at
        const next = i === at + 1
        return (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "grid size-6 place-items-center rounded-full border text-[10px] transition-colors",
                  done && "border-success bg-success text-white",
                  next && "border-brand text-brand ring-3 ring-brand/15",
                  !done && !next && "text-muted-foreground/60",
                )}
              >
                {done ? <CheckIcon className="size-3.5" strokeWidth={3} /> : next ? <span className="size-2 animate-pulse rounded-full bg-brand" /> : i + 1}
              </div>
              <span className={cn("text-[11px] whitespace-nowrap", !done && "text-muted-foreground")}>{i === 0 && draft ? "Draft" : s.label}</span>
            </div>
            {i < STAGES.length - 1 && <div className={cn("mx-1 mb-4 h-0.5 flex-1 rounded-full", i < at ? "bg-success" : "bg-border")} />}
          </div>
        )
      })}
    </div>
  )
}

function update(p: Proposal, patch: Partial<Proposal>) {
  useStore.setState((s) => ({ proposals: s.proposals.map((x) => (x.id === p.id ? { ...x, ...patch } : x)) }))
}

const FLASH = `@keyframes sous-flash { 0%, 35% { box-shadow: 0 0 0 3px var(--brand), 0 10px 40px -12px var(--brand) } 100% { box-shadow: 0 0 0 0 transparent } }`

function ProposalCard({ p, flash }: { p: Proposal; flash?: boolean }) {
  const repoName = p.repo.split("/").pop() ?? p.repo
  const ownerRepo = p.repo.replace(/^[^/]+\//, "")
  const owner = ownerRepo.split("/")[0]
  const versions = p.recipes.map((r) => `${r.name} ${r.to}`).join(", ")

  const advance = () => {
    const i = STAGES.findIndex((s) => s.key === p.stage)
    const next = STAGES[Math.min(i + 1, STAGES.length - 1)].key
    update(p, { stage: next, draft: false, note: next === "review" ? p.note : undefined })
  }
  const addChanges = () => {
    const ids = p.fileIds ?? []
    if (!ids.length) return toast("This is an example proposal: it has no files in this project.")
    for (const id of ids) useStore.getState().open(id)
    toast("Edit away. Your next Send adds the edits to #" + p.number)
  }
  const updateProject = () => {
    update(p, { updated: true })
    toast.success(`Updated to ${versions || "the release"}`, {
      description: p.keptLocal ? `sous repo unlink ${repoName} --update (simulated)` : `sous subscription update ${repoName} (simulated)`,
    })
  }

  const status: { text: React.ReactNode; icon: typeof CheckIcon; tone: string } =
    p.stage === "opened"
      ? p.draft
        ? { text: "Draft. Reviewers aren't asked yet.", icon: GitPullRequestDraftIcon, tone: "text-muted-foreground" }
        : { text: <>Checks running: <code className="font-mono">sous repo release --check</code></>, icon: SparklesIcon, tone: "text-muted-foreground" }
      : p.stage === "checks"
        ? { text: "Checks passed. Waiting for a maintainer to review it.", icon: CheckIcon, tone: "text-muted-foreground" }
        : p.stage === "review"
          ? { text: "Approved. A maintainer will merge it.", icon: CheckIcon, tone: "text-muted-foreground" }
          : p.stage === "merged"
            ? { text: `Merged. The release workflow is publishing ${versions || "it"} now.`, icon: GitMergeIcon, tone: "text-muted-foreground" }
            : p.updated
              ? { text: `Released, and this project uses ${versions || "it"}.`, icon: CheckIcon, tone: "text-success" }
              : { text: `Released: ${versions || "it"} is out.`, icon: SparklesIcon, tone: "text-success" }

  return (
    <div
      className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", p.stage === "released" && !p.updated && "border-success/40", flash && "border-brand/60")}
      style={flash ? { animation: "sous-flash 2.4s ease-out forwards" } : undefined}
    >
      <div className="flex items-start gap-3.5 p-4 pb-3">
        <RepoAvatar owner={owner} className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold">{p.title}</span>
            <span className="text-sm text-muted-foreground">#{p.number}</span>
            {p.stage === "released" && (
              <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10.5px] font-semibold text-success">
                <CheckIcon className="size-3" strokeWidth={3} /> Released
              </span>
            )}
            {p.draft && <span className="rounded-full border px-2 py-0.5 text-[10.5px] text-muted-foreground">Draft</span>}
            {p.kind === "core" && <span className="rounded-full bg-brand/12 px-2 py-0.5 text-[10.5px] font-medium text-brand">core</span>}
            {p.example && (
              <span className="rounded-full border border-dashed px-2 py-0.5 text-[10.5px] text-muted-foreground" title="Shown on first load to demo this page">
                Example
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{ownerRepo}</span>·
            <span className="flex items-center gap-1 font-mono text-[11px]">
              <GitBranchIcon className="size-3" />
              {p.head && p.head !== ownerRepo ? `${p.head}:` : ""}
              {p.branch}
            </span>
            ·<span>{p.openedAt}</span>
            {p.recipes.map((r) => (
              <span key={r.name} className="rounded-full bg-recipe/10 px-1.5 py-px font-mono text-[10.5px] text-recipe">
                {r.name} {r.from} → {r.to}
              </span>
            ))}
            {p.keptLocal && p.stage !== "released" && (
              <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10.5px]" title="Your build uses your edit on this machine until the release">
                <HardDriveIcon className="size-3" /> in your build now
              </span>
            )}
          </div>
        </div>
        <Button size="xs" variant="ghost" onClick={() => toast("Simulated: there's no real pull request.", { description: `https://${p.repo}/pull/${p.number}` })}>
          <ExternalLinkIcon /> Open
        </Button>
      </div>
      <div className="space-y-3 px-4 pb-4">
        <div className="px-1">
          <Timeline stage={p.stage} draft={p.draft} />
        </div>
        {p.note && p.stage !== "released" && (
          <div className={cn("flex gap-2.5 rounded-lg border px-3 py-2 text-xs", p.note.tone === "warning" ? "border-warning/40 bg-warning/6" : "bg-muted/30")}>
            <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              <b className="font-medium">A {p.note.who} commented:</b> {p.note.text}
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("flex items-center gap-1.5 text-xs", status.tone)}>
            <status.icon className="size-3.5" /> {status.text}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {p.draft && p.stage === "opened" && (
              <Button size="xs" variant="outline" onClick={() => update(p, { draft: false })}>
                <GitPullRequestArrowIcon /> Mark ready
              </Button>
            )}
            {p.stage !== "merged" && p.stage !== "released" && (
              <Button size="xs" variant="outline" onClick={addChanges}>
                <PencilLineIcon /> Add changes
              </Button>
            )}
            {p.stage === "released" && !p.updated && (
              <Button size="xs" className="bg-success text-white hover:bg-success/90" onClick={updateProject}>
                <DownloadIcon /> Update this project
              </Button>
            )}
            {p.stage !== "released" && (
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={advance} title="Demo control: move the proposal along">
                <FlaskConicalIcon /> Demo: next step
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, hint, items, flash }: { title: string; hint: string; items: Proposal[]; flash?: boolean }) {
  if (!items.length) return null
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className={cn("text-sm font-semibold", flash && "text-brand")}>{title}</h2>
        <span className="text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
      {items.map((p) => (
        <ProposalCard key={p.id} p={p} flash={flash} />
      ))}
    </section>
  )
}

export function ProposalsPage() {
  const proposals = useStore((s) => s.proposals)
  const setPage = useStore((s) => s.setPage)
  const justSentId = useJustSent((s) => s.id)
  const top = useRef<HTMLDivElement>(null)
  // "Just sent" lasts for this visit to the page.
  useEffect(() => {
    if (justSentId) top.current?.scrollIntoView({ block: "start" })
    return () => useJustSent.getState().set(null)
  }, [justSentId])
  const justSent = proposals.filter((p) => p.id === justSentId)
  const rest = proposals.filter((p) => p.id !== justSentId)
  const progress = rest.filter((p) => p.stage !== "released")
  const available = rest.filter((p) => p.stage === "released" && !p.updated)
  const done = rest.filter((p) => p.stage === "released" && p.updated)
  const examplesOnly = proposals.length > 0 && proposals.every((p) => p.example)
  const open = proposals.filter((p) => !p.example && p.stage !== "released").length
  return (
    <ScrollArea className="h-full">
      <style>{FLASH}</style>
      <div ref={top} className="mx-auto max-w-3xl space-y-7 p-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Proposals</h1>
          <p className="text-sm text-muted-foreground">
            What you proposed upstream, and where each one is, from opened to released. When one is released, move this project to it from here.
            {open > 0 && ` ${open} in progress.`}
          </p>
        </div>
        {examplesOnly && (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-4">
            <span className="grid size-9 place-items-center rounded-full bg-brand/12 text-brand">
              <PencilLineIcon className="size-4" />
            </span>
            <div className="text-sm">
              <div className="font-medium">You haven't proposed anything yet</div>
              <div className="text-xs text-muted-foreground">Edit a recipe file and propose it; it shows up here. The cards below are examples.</div>
            </div>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => setPage("editor")}>
              Back to the editor
            </Button>
          </div>
        )}
        {proposals.length === 0 && (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            Nothing yet. Edit a recipe file and propose it; it shows up here.
          </div>
        )}
        <Section title="Just sent" hint="simulated: what Propose would open" items={justSent} flash />
        <Section title="In progress" hint="waiting on checks, review or the release" items={progress} />
        <Section title="Released, update available" hint="the new version is out" items={available} />
        <Section title="Done" hint="this project uses the release" items={done} />
        {proposals.length > 0 && (
          <p className="-mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FlaskConicalIcon className="size-3" /> The cards above are simulated in this session, not on GitHub. Your real pull requests are below.
          </p>
        )}
        <div className="h-px bg-border" />
        <MyPullRequests />
      </div>
    </ScrollArea>
  )
}
