// The "Send changes" flow. What it shows is real: your diffs, the merge onto
// upstream HEAD, the recipe manifests and their `submissions` policy, the repo
// index's released versions, the repo's `contribute:` link, and whether `gh` is
// signed in and can push (GET /api/contribute-info). Everything from "Propose"
// onwards (link, commit, push, fork, pull request) is simulated and says so.

import { useEffect, useState } from "react"
import { CheckIcon, FlaskConicalIcon, GitPullRequestArrowIcon, HardDriveDownloadIcon, PencilLineIcon } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { unsentIds, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { RepoAvatar } from "./contribute/avatar"
import { groupChanges, lineStats, useContributeInfo, type Group } from "./contribute/model"
import { ProposalSheet } from "./contribute/sheet"

function GroupCard({ g, selected, done, frozen, onClick }: { g: Group; selected: boolean; done: boolean; frozen?: { added: number; removed: number }; onClick: () => void }) {
  const docs = useStore((s) => s.docs)
  const live = g.files.reduce(
    (acc, f) => {
      const d = docs[f.id]
      // Edits that go into an open proposal count from what was last sent.
      const s = d ? lineStats(d.proposedIn ? (d.proposedContent ?? d.original) : d.original, d.current) : { added: 0, removed: 0 }
      return { added: acc.added + s.added, removed: acc.removed + s.removed }
    },
    { added: 0, removed: 0 },
  )
  const stats = frozen ?? live
  const action =
    g.kind === "project"
      ? done ? "saved" : "save in this project"
      : g.kind === "sample"
        ? "nowhere to send"
        : g.kind === "core"
          ? done ? "proposed · core recipes" : "propose · core recipes"
          : done ? "proposed" : "propose as a pull request"
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-all",
        selected ? "bg-background shadow-sm ring-1 ring-border" : "hover:bg-background/60",
      )}
    >
      {g.kind === "pr" || g.kind === "core" ? (
        <RepoAvatar owner={g.owner} className="size-8 shrink-0" />
      ) : (
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", g.kind === "project" ? "bg-project/15 text-project" : "bg-sample/15 text-sample")}>
          {g.kind === "project" ? <HardDriveDownloadIcon className="size-4" /> : <FlaskConicalIcon className="size-4" />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{g.kind === "project" ? `This project (${g.title})` : g.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">→ {action}</span>
        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {g.recipes.length > 0 && `${g.recipes.length} recipe${g.recipes.length === 1 ? "" : "s"}, `}
          {g.files.length} file{g.files.length === 1 ? "" : "s"}
          <span className="font-mono">
            <span className="text-success">+{stats.added}</span> <span className="text-destructive">−{stats.removed}</span>
          </span>
        </span>
      </span>
      {done && (
        <span className="grid size-5 place-items-center rounded-full bg-success text-white">
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

/** "1 proposal to sous-io/sous-recipes, and 1 file to save in this project." */
function summaryLine(groups: Group[]): string {
  const parts: string[] = []
  for (const g of groups) {
    const n = g.files.length
    const files = `${n} file${n === 1 ? "" : "s"}`
    if (g.kind === "pr" || g.kind === "core") parts.push(`a proposal to ${g.title} (${files})`)
    else if (g.kind === "project") parts.push(`${files} to save in this project`)
  }
  if (!parts.length) return "Your edits, checked and ready to go where they belong."
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
  return `${list[0].toUpperCase()}${list.slice(1)}.`
}

export function ContributeDialog() {
  const open = useStore((s) => s.contributeOpen)
  const focus = useStore((s) => s.contributeFocus)
  const close = useStore((s) => s.closeContribute)
  const docs = useStore((s) => s.docs)
  const workspace = useStore((s) => s.workspace)
  const info = useContributeInfo((s) => s.info)
  const load = useContributeInfo((s) => s.load)
  const [selected, setSelected] = useState<string | null>(null)
  // The files are frozen while the dialog is open, so a finished proposal stays on screen.
  const [ids, setIds] = useState<string[]>([])
  const [done, setDone] = useState<Set<string>>(new Set())
  // Line counts of saved groups, kept after the save makes them the file on disk.
  const [frozen, setFrozen] = useState<Record<string, { added: number; removed: number }>>({})

  useEffect(() => {
    if (!open || !workspace) return
    const next = unsentIds(docs)
    setIds(next)
    setDone(new Set())
    setFrozen({})
    load(next)
    const groups = groupChanges(workspace.files, next, workspace.projectName, null)
    const focusGroup = groups.find((g) => g.files.some((f) => f.id === focus))
    setSelected(focusGroup?.key ?? groups[0]?.key ?? null)
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const groups = workspace ? groupChanges(workspace.files, ids, workspace.projectName, info) : []
  const group = groups.find((g) => g.key === selected) ?? groups[0]
  const empty = groups.length === 0
  const nextUp = groups.find((g) => g.key !== group?.key && !done.has(g.key) && g.kind !== "sample")
  const single = groups.length === 1

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          empty ? "max-w-md sm:max-w-md" : "h-[min(860px,92vh)] max-w-[min(1080px,95vw)] sm:max-w-[min(1080px,95vw)]",
          !empty && single && "max-w-[min(860px,95vw)] sm:max-w-[min(860px,95vw)]",
        )}
      >
        {empty ? (
          <div className="flex flex-col items-center px-8 py-10 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-muted">
              <PencilLineIcon className="size-5 text-muted-foreground" />
            </span>
            <DialogTitle className="mt-4 text-base">Nothing to propose or save</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm">
              Edit any file and it shows up here. You propose recipe edits to the recipe's repository as a pull request; you save your project's own files to disk.
            </DialogDescription>
            <Button className="mt-5" variant="outline" onClick={close}>
              Back to the editor
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-6 py-3.5">
              <DialogTitle className="flex items-center gap-2 text-[15px]">
                <GitPullRequestArrowIcon className="size-4 text-brand" /> Review your changes
              </DialogTitle>
              <DialogDescription className="text-xs">
                {summaryLine(groups)} The checks and diffs are real; proposing and saving are simulated.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1">
              {!single && (
                <div className="w-68 shrink-0 space-y-1 overflow-y-auto border-r bg-muted/30 p-2">
                  <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">Where your edits go</div>
                  {groups.map((g) => (
                    <GroupCard key={g.key} g={g} selected={group?.key === g.key} done={done.has(g.key)} frozen={frozen[g.key]} onClick={() => setSelected(g.key)} />
                  ))}
                </div>
              )}
              <ScrollArea className="min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:min-h-full">
                {group && (
                  <ProposalSheet
                    key={`${group.key}:${group.kind}`}
                    group={group}
                    onDone={(_, stats) => {
                      setDone((d) => new Set(d).add(group.key))
                      if (stats) setFrozen((f) => ({ ...f, [group.key]: stats }))
                    }}
                    next={nextUp ? { label: nextUp.kind === "project" ? `save ${nextUp.files.length} file${nextUp.files.length === 1 ? "" : "s"} in this project` : `propose to ${nextUp.title}`, go: () => setSelected(nextUp.key) } : undefined}
                  />
                )}
              </ScrollArea>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
