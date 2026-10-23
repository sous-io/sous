// MOCK: tracks proposals made from the GUI, from "opened" to "released", and
// offers the update once the new version is out.

import { CheckIcon, CircleDotIcon, DownloadIcon, ExternalLinkIcon, GitPullRequestArrowIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
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

function Timeline({ stage }: { stage: ProposalStage }) {
  const at = STAGES.findIndex((s) => s.key === stage)
  return (
    <div className="flex items-center">
      {STAGES.map((s, i) => (
        <div key={s.key} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center gap-1">
            <div
              className={cn(
                "grid size-6 place-items-center rounded-full border text-[10px]",
                i < at && "border-emerald-500 bg-emerald-500 text-white",
                i === at && "border-[var(--cm-liquid)] text-[var(--cm-liquid)]",
                i > at && "text-muted-foreground",
              )}
            >
              {i < at ? <CheckIcon className="size-3.5" /> : i === at ? <CircleDotIcon className="size-3.5" /> : i + 1}
            </div>
            <span className={cn("text-[11px] whitespace-nowrap", i > at && "text-muted-foreground")}>{s.label}</span>
          </div>
          {i < STAGES.length - 1 && <div className={cn("mx-1 mb-4 h-px flex-1", i < at ? "bg-emerald-500" : "bg-border")} />}
        </div>
      ))}
    </div>
  )
}

function ProposalCard({ p }: { p: Proposal }) {
  const advance = () => {
    const i = STAGES.findIndex((s) => s.key === p.stage)
    const next = STAGES[Math.min(i + 1, STAGES.length - 1)].key
    useStore.setState((s) => ({ proposals: s.proposals.map((x) => (x.id === p.id ? { ...x, stage: next } : x)) }))
  }
  const what =
    p.stage === "opened"
      ? "Waiting for the repository's checks to run."
      : p.stage === "checks"
        ? "Checks passed. Waiting for a maintainer to review it."
        : p.stage === "review"
          ? "Approved. It will be merged by a maintainer."
          : p.stage === "merged"
            ? "Merged. It ships with the repository's next release."
            : `Released. ${p.recipes.map((r) => `${r.name} ${r.to}`).join(", ")} is available.`
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          <GitPullRequestArrowIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm">
              {p.title}{" "}
              <span className="font-normal text-muted-foreground">
                #{p.number}
              </span>
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{p.repo.replace("github.com/", "")}</span>·<span className="font-mono">{p.branch}</span>·
              <span>{p.openedAt}</span>
              {p.draft && <Badge variant="outline">draft</Badge>}
              {p.recipes.map((r) => (
                <Badge key={r.name} variant="secondary" className="font-mono text-[10px]">
                  {r.name} {r.from} → {r.to}
                </Badge>
              ))}
            </div>
          </div>
          <Button size="xs" variant="ghost" onClick={() => toast("It's a mock: there is no real pull request.")}>
            <ExternalLinkIcon /> Open
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Timeline stage={p.stage} />
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{what}</p>
          <div className="ml-auto flex gap-2">
            {p.stage === "released" && p.recipes.length > 0 ? (
              <Button size="xs" onClick={() => toast.success(`Updated to ${p.recipes.map((r) => `${r.name} ${r.to}`).join(", ")} (mock)`)}>
                <DownloadIcon /> Update this project
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={advance} title="Mock: move the proposal along">
                Simulate next step
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function ProposalsPage() {
  const proposals = useStore((s) => s.proposals)
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-4 p-8">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Proposals <Badge variant="outline">mock</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            Changes you sent upstream, and where each one is. When one is released, update to it from here.
          </p>
        </div>
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} />
        ))}
      </div>
    </ScrollArea>
  )
}
