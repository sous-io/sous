// MOCK: the "propose my changes upstream" flow. The diffs are real (computed
// from your edits); everything from "Propose" onwards is simulated. The steps
// mirror what `sous repo contribute` does today.

import { useEffect, useMemo, useState } from "react"
import { structuredPatch } from "diff"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  CopyIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
  HouseIcon,
  LoaderIcon,
  PackageIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Kbd } from "@/components/ui/kbd"
import type { WorkspaceFile } from "@/lib/api"
import { changedIds, useStore, type OpenDoc } from "@/lib/store"
import { cn } from "@/lib/utils"
import { bump, contributionBranch, type Proposal } from "@/mock/data"

type Group = {
  key: string
  kind: "recipe-repo" | "project" | "sample"
  title: string
  subtitle: string
  files: WorkspaceFile[]
  recipes: { name: string; version: string }[]
}

function groupChanges(files: WorkspaceFile[], ids: string[], branch: string, projectName: string): Group[] {
  const groups = new Map<string, Group>()
  for (const id of ids) {
    const f = files.find((x) => x.id === id)
    if (!f) continue
    const o = f.origin
    let key: string
    let group: Group
    if (o.kind === "recipe") {
      key = `${o.host}/${o.owner}/${o.repo}`
      group = groups.get(key) ?? {
        key,
        kind: "recipe-repo",
        title: `${o.owner}/${o.repo}`,
        subtitle: "Recipe repository · pull request",
        files: [],
        recipes: [],
      }
      const name = `${o.namespace}/${o.recipe}`
      if (!group.recipes.some((r) => r.name === name)) group.recipes.push({ name, version: o.version })
    } else if (o.kind === "sample") {
      key = "sample"
      group = groups.get(key) ?? { key, kind: "sample", title: "POC samples", subtitle: "Not real files", files: [], recipes: [] }
    } else {
      key = "project"
      group = groups.get(key) ?? {
        key,
        kind: "project",
        title: projectName,
        subtitle: `This project · commit to ${branch}`,
        files: [],
        recipes: [],
      }
    }
    group.files.push(f)
    groups.set(key, group)
  }
  const order = { "recipe-repo": 0, project: 1, sample: 2 }
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind])
}

function shortName(f: WorkspaceFile): string {
  const parts = f.display.split("/")
  const skill = parts.indexOf("skills")
  if (skill >= 0 && parts[skill + 1]) return parts[skill + 1]
  return parts[parts.length - 1].replace(/\.tpl\.md$|\.md$/, "")
}

function lineStats(doc: OpenDoc): { added: number; removed: number } {
  const patch = structuredPatch("a", "b", doc.original, doc.current, "", "", { context: 0 })
  let added = 0
  let removed = 0
  for (const h of patch.hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++
      else if (l.startsWith("-")) removed++
    }
  return { added, removed }
}

function defaultTitle(group: Group): string {
  const names = [...new Set(group.files.map(shortName))]
  if (group.kind === "project") return `Update ${names.join(", ")}`
  const recipe = group.recipes.length === 1 ? group.recipes[0].name : `${group.recipes.length} recipes`
  return `${recipe}: update ${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`
}

function defaultBody(group: Group, docs: Record<string, OpenDoc>): string {
  const lines = group.files.map((f) => {
    const s = lineStats(docs[f.id])
    return `- \`${f.display}\`: ${s.added} line${s.added === 1 ? "" : "s"} added, ${s.removed} removed`
  })
  return `## Changes\n\n${lines.join("\n")}\n\nProposed from \`sous serve\`.`
}

function claudeBody(group: Group, docs: Record<string, OpenDoc>): string {
  const added = group.files.flatMap((f) => {
    const patch = structuredPatch("a", "b", docs[f.id].original, docs[f.id].current, "", "", { context: 0 })
    return patch.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1).trim()))
  })
  const sample = added.filter(Boolean).slice(0, 3)
  return [
    "## Problem",
    "",
    `The text in ${group.files.map((f) => `\`${shortName(f)}\``).join(", ")} did not say what agents needed it to say.`,
    "",
    "## Change",
    "",
    ...(sample.length ? sample.map((l) => `- Adds: “${l.length > 90 ? l.slice(0, 90) + "…" : l}”`) : ["- Removes outdated text."]),
    "",
    "## Testing",
    "",
    "Rendered with this project's variables in `sous serve`; the output matched what I expected.",
  ].join("\n")
}

function DiffView({ doc }: { doc: OpenDoc }) {
  const patch = useMemo(() => structuredPatch("a", "b", doc.original, doc.current, "", "", { context: 2 }), [doc])
  return (
    <div className="overflow-x-auto rounded-md border bg-background font-mono text-[11.5px] leading-5">
      {patch.hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/60 px-3 text-muted-foreground">
            @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={cn(
                "px-3 whitespace-pre-wrap",
                l.startsWith("+") && "diff-add",
                l.startsWith("-") && "diff-del",
              )}
            >
              <span className="mr-2 inline-block w-2 text-muted-foreground select-none">{l[0]}</span>
              {l.slice(1) || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

type Step = { label: string; detail: string }

function stepsFor(group: Group, branch: string, projectBranch: string): Step[] {
  if (group.kind === "project") {
    return [
      { label: "Writing your edits to disk", detail: `${group.files.length} file(s)` },
      { label: "Committing", detail: `on ${projectBranch}` },
      { label: "Pushing", detail: `origin/${projectBranch}` },
      { label: "Opening a pull request", detail: "into main" },
    ]
  }
  return [
    { label: `Linking ${group.title}`, detail: `a checkout on a new branch, ${branch}` },
    { label: "Copying your edits into it", detail: `${group.files.length} file(s)` },
    { label: "Raising recipe versions", detail: group.recipes.map((r) => r.name).join(", ") },
    { label: "Committing and pushing", detail: `origin/${branch}` },
    { label: "Opening a pull request", detail: `on ${group.title}` },
    { label: "Unlinking", detail: "this project goes back to the released recipe" },
  ]
}

function GroupPanel({ group, onProposed }: { group: Group; onProposed: () => void }) {
  const docs = useStore((s) => s.docs)
  const projectBranch = useStore((s) => s.workspace?.branch ?? "main")
  const addProposal = useStore((s) => s.addProposal)
  const setPage = useStore((s) => s.setPage)
  const closeContribute = useStore((s) => s.closeContribute)

  const [title, setTitle] = useState(() => defaultTitle(group))
  const [body, setBody] = useState(() => defaultBody(group, docs))
  const [bumps, setBumps] = useState<Record<string, "patch" | "minor" | "major">>({})
  const [draft, setDraft] = useState(false)
  const [updateAfter, setUpdateAfter] = useState(true)
  const [writing, setWriting] = useState(false)
  const [progress, setProgress] = useState(-1)
  const [result, setResult] = useState<Proposal | null>(null)
  const branch = useMemo(contributionBranch, [])
  const steps = stepsFor(group, branch, projectBranch)
  const running = progress >= 0 && !result

  const draftWithClaude = () => {
    const text = claudeBody(group, docs)
    setWriting(true)
    setBody("")
    let i = 0
    const tick = window.setInterval(() => {
      i += 6
      setBody(text.slice(0, i))
      if (i >= text.length) {
        window.clearInterval(tick)
        setWriting(false)
      }
    }, 16)
  }

  const propose = () => {
    setProgress(0)
    let step = 0
    const tick = window.setInterval(() => {
      step++
      setProgress(step)
      if (step >= steps.length) {
        window.clearInterval(tick)
        const proposal: Proposal = {
          id: `p-${Date.now()}`,
          repo: group.kind === "project" ? "github.com/sous-io/sous" : group.key,
          number: 214 + Math.floor(Math.random() * 20),
          title,
          branch: group.kind === "project" ? projectBranch : branch,
          recipes: group.recipes.map((r) => ({ name: r.name, from: r.version, to: bump(r.version, bumps[r.name] ?? "patch") })),
          files: group.files.length,
          stage: "opened",
          openedAt: "just now",
          draft,
        }
        setResult(proposal)
        addProposal(
          proposal,
          group.files.map((f) => f.id),
        )
        onProposed()
      }
    }, 550)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && progress < 0 && group.kind !== "sample") propose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const refs = group.recipes.map((r) => r.name)
  const command =
    group.kind === "project"
      ? `git add ${group.files.map((f) => f.display).join(" ")}\ngit commit -m ${JSON.stringify(title)}\ngit push\ngh pr create --title ${JSON.stringify(title)} --body-file -`
      : [
          `sous repo contribute ${refs[0] ?? group.title} --create-branch ${branch}`,
          `# sous copies your edits into the linked checkout and raises the versions`,
          `sous repo contribute ${refs[0] ?? group.title} --finish --commit${draft ? " --draft" : ""} \\`,
          `  --title ${JSON.stringify(title)} \\`,
          `  --body "…"`,
          ...(updateAfter ? [`# later, once the release is out:`, `sous update`] : []),
        ].join("\n")

  if (group.kind === "sample") {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FlaskConicalIcon className="size-4 text-[var(--cm-liquid)]" /> POC samples are not real files
        </div>
        <p className="text-sm text-muted-foreground">
          The sample template lives only in this server's memory, so there is nowhere to send it. Edit a recipe file
          (Recipes tab → any <code>.tpl.md</code>) to try the upstream flow.
        </p>
        {group.files.map((f) => (
          <DiffView key={f.id} doc={docs[f.id]} />
        ))}
      </div>
    )
  }

  if (progress >= 0) {
    return (
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <div className="text-sm font-medium">{result ? "Done." : `Proposing to ${group.title}…`}</div>
          <p className="text-xs text-muted-foreground">Simulated: nothing is sent anywhere in this proof of concept.</p>
        </div>
        <ol className="space-y-2.5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5">
                {i < progress ? (
                  <CheckIcon className="size-4 text-emerald-500" />
                ) : i === progress ? (
                  <LoaderIcon className="size-4 animate-spin text-[var(--cm-liquid)]" />
                ) : (
                  <CircleIcon className="size-4 text-muted-foreground/40" />
                )}
              </span>
              <span className={cn(i > progress && "text-muted-foreground")}>
                {s.label}
                <span className="block text-xs text-muted-foreground">{s.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        {result && (
          <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <GitPullRequestArrowIcon className="size-4 text-emerald-500" />
              Pull request #{result.number} opened{result.draft ? " as a draft" : ""}
              <Badge variant="outline" className="ml-1 text-[10px]">
                mock
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              “{result.title}” on {group.title}.{" "}
              {group.kind === "recipe-repo" &&
                (updateAfter
                  ? "When it is merged and released, sous will offer to update this project to the new version."
                  : "This project stays on the released version.")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  closeContribute()
                  setPage("proposals")
                }}
              >
                Track it
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(`https://${result.repo}/pull/${result.number}`).catch(() => {})
                  toast.success("Link copied (it's a mock link)")
                }}
              >
                <CopyIcon /> Copy link
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <div className="text-base font-semibold">
          {group.kind === "project" ? `Commit to ${projectBranch}` : `Propose to ${group.title}`}
        </div>
        <p className="text-sm text-muted-foreground">
          {group.kind === "project"
            ? "Sous commits your edits on this branch, pushes it and opens a pull request."
            : "Sous opens the pull request for you. No checkout, no branch, no git commands."}
        </p>
      </div>

      <section className="space-y-2">
        <Label className="text-xs tracking-wide text-muted-foreground uppercase">Your changes</Label>
        {group.files.map((f) => {
          const s = lineStats(docs[f.id])
          return (
            <Collapsible key={f.id} defaultOpen={group.files.length <= 2}>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent">
                <ChevronDownIcon className="size-3.5 -rotate-90 text-muted-foreground transition-transform group-data-[panel-open]:rotate-0" />
                <span className="truncate font-mono text-xs">{f.display}</span>
                <span className="ml-auto shrink-0 font-mono text-xs">
                  <span className="text-emerald-500">+{s.added}</span> <span className="text-red-500">−{s.removed}</span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-1.5">
                <DiffView doc={docs[f.id]} />
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </section>

      {group.recipes.length > 0 && (
        <section className="space-y-2">
          <Label className="text-xs tracking-wide text-muted-foreground uppercase">New version</Label>
          {group.recipes.map((r) => {
            const kind = bumps[r.name] ?? "patch"
            return (
              <div key={r.name} className="flex items-center gap-3 text-sm">
                <PackageIcon className="size-4 text-sky-500" />
                <span className="font-medium">{r.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {r.version} → <b className="text-foreground">{bump(r.version, kind)}</b>
                </span>
                <ToggleGroup
                  className="ml-auto"
                  variant="outline"
                  size="sm"
                  value={[kind]}
                  onValueChange={(v) => v[0] && setBumps({ ...bumps, [r.name]: v[0] as typeof kind })}
                >
                  <ToggleGroupItem value="patch" className="px-2 text-xs" title="A fix or a wording change">
                    Patch
                  </ToggleGroupItem>
                  <ToggleGroupItem value="minor" className="px-2 text-xs" title="Something new that changes nothing existing">
                    Minor
                  </ToggleGroupItem>
                  <ToggleGroupItem value="major" className="px-2 text-xs" title="Something that changes what existing users get">
                    Major
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            )
          })}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center">
          <Label className="text-xs tracking-wide text-muted-foreground uppercase">Title and description</Label>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={draftWithClaude} disabled={writing}>
            <SparklesIcon className="text-[var(--cm-liquid)]" /> {writing ? "Writing…" : "Write it with Claude"}
          </Button>
        </div>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} className="font-mono text-xs" />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch id="draft" checked={draft} onCheckedChange={setDraft} />
          <Label htmlFor="draft" className="text-sm font-normal">
            Open it as a draft
          </Label>
        </div>
        {group.kind === "recipe-repo" && (
          <div className="flex items-center gap-3">
            <Switch id="update" checked={updateAfter} onCheckedChange={setUpdateAfter} />
            <Label htmlFor="update" className="text-sm font-normal">
              Update this project to the new version once it's released
            </Label>
          </div>
        )}
      </section>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <TerminalIcon className="size-3.5" /> What sous runs for you
          <ChevronDownIcon className="size-3 transition-transform group-data-[panel-open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {command}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      <div className="sticky bottom-0 -mx-6 flex items-center gap-3 border-t bg-background/95 px-6 py-3 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {group.files.length} file{group.files.length === 1 ? "" : "s"}
          {group.recipes.length > 0 && ` · ${group.recipes.length} recipe${group.recipes.length === 1 ? "" : "s"}`}
        </span>
        <Button className="ml-auto" onClick={propose} disabled={running || !title.trim()}>
          <GitPullRequestArrowIcon />
          {group.kind === "project" ? "Commit & open pull request" : "Propose change"}
          <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">Ctrl ↵</Kbd>
        </Button>
      </div>
    </div>
  )
}

export function ContributeDialog() {
  const open = useStore((s) => s.contributeOpen)
  const focus = useStore((s) => s.contributeFocus)
  const close = useStore((s) => s.closeContribute)
  const docs = useStore((s) => s.docs)
  const workspace = useStore((s) => s.workspace)
  const [selected, setSelected] = useState<string | null>(null)
  // Freeze the groups while the dialog is open, so a finished proposal stays on screen.
  const [frozen, setFrozen] = useState<Group[]>([])

  useEffect(() => {
    if (!open || !workspace) return
    const ids = changedIds(docs).filter((id) => !docs[id].proposedIn)
    const groups = groupChanges(workspace.files, ids, workspace.branch, workspace.projectName)
    setFrozen(groups)
    const focusFile = workspace.files.find((f) => f.id === focus)
    const focusGroup = focusFile
      ? groups.find((g) => g.files.some((f) => f.id === focusFile.id))
      : undefined
    setSelected(focusGroup?.key ?? groups[0]?.key ?? null)
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const group = frozen.find((g) => g.key === selected)
  const [done, setDone] = useState<Set<string>>(new Set())

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[min(820px,90vh)] max-w-[min(1100px,95vw)] flex-col gap-0 p-0 sm:max-w-[min(1100px,95vw)]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequestArrowIcon className="size-4" /> Send your changes
          </DialogTitle>
          <DialogDescription>
            Each place your edits came from gets its own proposal. The diffs are real; sending them is simulated.
          </DialogDescription>
        </DialogHeader>
        {frozen.length === 0 ? (
          <div className="grid flex-1 place-items-center p-10 text-center text-sm text-muted-foreground">
            Nothing to send yet. Edit a file, and it shows up here.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-72 shrink-0 space-y-1 border-r bg-muted/30 p-2">
              {frozen.map((g) => {
                const Icon = g.kind === "recipe-repo" ? GitBranchIcon : g.kind === "project" ? HouseIcon : FlaskConicalIcon
                return (
                  <button
                    key={g.key}
                    onClick={() => setSelected(g.key)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md p-2.5 text-left hover:bg-accent",
                      selected === g.key && "bg-background shadow-sm ring-1 ring-border",
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{g.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{g.subtitle}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {g.files.length} file{g.files.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    {done.has(g.key) && <CheckIcon className="size-4 text-emerald-500" />}
                  </button>
                )
              })}
            </div>
            <ScrollArea className="min-w-0 flex-1">
              {group && (
                <GroupPanel
                  key={group.key}
                  group={group}
                  onProposed={() => setDone((d) => new Set(d).add(group.key))}
                />
              )}
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
