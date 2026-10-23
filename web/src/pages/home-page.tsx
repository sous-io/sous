// Home page: the project at a glance, and everything that needs attention.
// REAL: every number and every item comes from the build, the recipe store,
// the variables report and the open edits.

import { useEffect, useState } from "react"
import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CopyIcon,
  FileCode2Icon,
  FileOutputIcon,
  FlaskConicalIcon,
  GitPullRequestArrowIcon,
  PackageIcon,
  SparklesIcon,
  TriangleAlertIcon,
  VariableIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, type VarFact } from "@/lib/api"
import { changedIds, unsentIds, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

type Attention = {
  key: string
  tone: "error" | "warning" | "info"
  icon: typeof CircleAlertIcon
  title: string
  detail: string
  action?: { label: string; run: () => void }
}

function Stat({ icon: Icon, label, value, sub, tone, onClick }: { icon: typeof PackageIcon; label: string; value: string; sub?: string; tone?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="group rounded-xl border bg-card p-4 text-left transition hover:border-brand/50 hover:shadow-md">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        <Icon className={cn("size-3.5", tone)} /> {label}
        <ArrowRightIcon className="ml-auto size-3.5 opacity-0 transition group-hover:opacity-60" />
      </div>
      <div className="mt-1.5 text-2xl font-bold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </button>
  )
}

export function HomePage() {
  const workspace = useStore((s) => s.workspace)!
  const build = useStore((s) => s.build)
  const catalog = useStore((s) => s.catalog)
  const docs = useStore((s) => s.docs)
  const proposals = useStore((s) => s.proposals)
  const setPage = useStore((s) => s.setPage)
  const open = useStore((s) => s.open)
  const openContribute = useStore((s) => s.openContribute)
  const [vars, setVars] = useState<VarFact[] | null>(null)
  useEffect(() => {
    api.variables().then(setVars).catch(() => setVars([]))
  }, [])

  const files = workspace.files
  const projectFiles = files.filter((f) => f.origin.kind === "project").length
  const recipeFiles = files.filter((f) => f.origin.kind === "recipe").length
  const outputs = build?.outputs ?? []
  const failed = outputs.filter((o) => o.status === "failed")
  const missing = outputs.filter((o) => o.status === "missing")
  const stale = outputs.filter((o) => o.status === "stale")
  const startTokens =
    outputs.filter((o) => o.kind === "instructions" && !o.output.includes("/")).reduce((n, o) => n + o.tokens, 0) +
    outputs.filter((o) => o.kind === "skill").reduce((n, o) => n + (o.descriptionTokens ?? 0), 0)
  const used = catalog?.filter((r) => r.using) ?? []
  const updates = used.filter((r) => r.using !== r.latest)
  const unanswered = vars?.filter((v) => v.recipe && v.value === null) ?? []
  const unsent = unsentIds(docs)
  const changed = changedIds(docs)
  const openProposals = proposals.filter((p) => p.stage !== "released" && !(p as { example?: boolean }).example)

  const attention: Attention[] = []
  for (const o of failed) {
    attention.push({
      key: `fail-${o.output}`,
      tone: "error",
      icon: CircleAlertIcon,
      title: `${o.output} can't be built`,
      detail: o.error?.split("\n")[0] ?? "The build fails.",
      action: { label: "Open its template", run: () => open(o.entryId) },
    })
  }
  if (unanswered.length) {
    attention.push({
      key: "unanswered",
      tone: "warning",
      icon: VariableIcon,
      title: `${unanswered.length} variable${unanswered.length === 1 ? " has" : "s have"} no value`,
      detail: `${unanswered.map((v) => v.name).join(", ")} render as empty text. Answer them with sous vars ask.`,
      action: { label: "See variables", run: () => setPage("variables") },
    })
  }
  if (unsent.length) {
    attention.push({
      key: "unsent",
      tone: "warning",
      icon: GitPullRequestArrowIcon,
      title: `${unsent.length} edited file${unsent.length === 1 ? "" : "s"} not sent yet`,
      detail: "Your edits only live in this tab. Send them upstream, or they're gone when you close it.",
      action: { label: "Send changes", run: () => openContribute() },
    })
  }
  for (const r of updates) {
    attention.push({
      key: `update-${r.key}`,
      tone: "info",
      icon: ArrowUpCircleIcon,
      title: `${r.namespace}/${r.name} ${r.latest} is downloaded but not applied`,
      detail: `This project uses ${r.using}.`,
      action: { label: "See recipes", run: () => setPage("recipes") },
    })
  }
  if (missing.length) {
    attention.push({
      key: "missing",
      tone: "info",
      icon: CircleDashedIcon,
      title: `${missing.length} output${missing.length === 1 ? " isn't" : "s aren't"} built yet`,
      detail: "Your agent can't read them until you run sous build.",
      action: {
        label: "Copy command",
        run: () => {
          navigator.clipboard?.writeText("sous build").catch(() => {})
          toast.success("Copied: sous build")
        },
      },
    })
  }
  if (stale.length) {
    attention.push({
      key: "stale",
      tone: "warning",
      icon: TriangleAlertIcon,
      title: `${stale.length} output${stale.length === 1 ? " is" : "s are"} out of date`,
      detail: "A fresh build would change them. Someone, or an agent, may have edited them by hand.",
      action: { label: "See build", run: () => setPage("build") },
    })
  }

  const toneCls = { error: "border-destructive/40 bg-destructive/6", warning: "border-warning/40 bg-warning/6", info: "border-recipe/30 bg-recipe/5" }
  const iconCls = { error: "text-destructive", warning: "text-warning", info: "text-recipe" }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-7 p-8">
        <div className="relative overflow-hidden rounded-2xl border bg-card p-6">
          <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-brand/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 left-1/3 size-72 rounded-full bg-brand-2/10 blur-3xl" />
          <div className="relative">
            <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Project</div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{workspace.projectName}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {workspace.projectRoot} · {workspace.branch}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={() => open("sample")}>
                <SparklesIcon /> Try the live Liquid editor
              </Button>
              <Button variant="outline" onClick={() => setPage("context")}>
                <BotIcon /> See what your agent reads
              </Button>
              {unsent.length > 0 && (
                <Button variant="outline" onClick={() => openContribute()}>
                  <GitPullRequestArrowIcon /> Send {unsent.length} change{unsent.length === 1 ? "" : "s"}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat icon={FileCode2Icon} label="Sources" value={String(files.length)} sub={`${projectFiles} project · ${recipeFiles} recipe`} onClick={() => setPage("editor")} />
          <Stat
            icon={FileOutputIcon}
            label="Outputs"
            value={build ? String(outputs.length) : "…"}
            sub={failed.length ? `${failed.length} failing` : "all build"}
            tone={failed.length ? "text-destructive" : undefined}
            onClick={() => setPage("build")}
          />
          <Stat icon={BotIcon} label="Session start" value={build ? `${(startTokens / 1000).toFixed(1)}k` : "…"} sub="tokens read up front" tone="text-brand" onClick={() => setPage("context")} />
          <Stat icon={PackageIcon} label="Recipes" value={catalog ? String(used.length) : "…"} sub={updates.length ? `${updates.length} update ready` : "all current"} tone="text-recipe" onClick={() => setPage("recipes")} />
          <Stat
            icon={VariableIcon}
            label="Variables"
            value={vars ? String(vars.length) : "…"}
            sub={unanswered.length ? `${unanswered.length} unanswered` : "all answered"}
            tone="text-liquid"
            onClick={() => setPage("variables")}
          />
          <Stat
            icon={GitPullRequestArrowIcon}
            label="Proposals"
            value={String(openProposals.length)}
            sub={changed.length ? `${changed.length} file${changed.length === 1 ? "" : "s"} edited` : "open"}
            tone="text-success"
            onClick={() => setPage("proposals")}
          />
        </div>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Needs attention
            <span className="rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">{attention.length}</span>
          </h2>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/6 p-4 text-sm">
              <CheckCircle2Icon className="size-4 text-success" /> Everything builds, every variable has a value, and every recipe is current.
            </div>
          ) : (
            <div className="space-y-2">
              {attention.map((a) => (
                <div key={a.key} className={cn("flex items-center gap-3 rounded-xl border p-3.5", toneCls[a.tone])}>
                  <a.icon className={cn("size-4.5 shrink-0", iconCls[a.tone])} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{a.title}</div>
                    <div className="truncate text-xs text-muted-foreground" title={a.detail}>
                      {a.detail}
                    </div>
                  </div>
                  {a.action && (
                    <Button size="sm" variant="outline" className="shrink-0 bg-background/60" onClick={a.action.run}>
                      {a.action.label === "Copy command" && <CopyIcon />}
                      {a.action.label}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Try it</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                icon: SparklesIcon,
                title: "Edit Liquid, see it render",
                body: "Open the showcase template, click any purple section, change it, and press Esc.",
                run: () => open("sample"),
              },
              {
                icon: FlaskConicalIcon,
                title: "Try another value",
                body: "In the editor's Variables tab, click a value and type another one. The output follows; nothing is saved.",
                run: () => open("sample"),
              },
              {
                icon: GitPullRequestArrowIcon,
                title: "Send a fix upstream",
                body: "Open any recipe file, fix a word, and press Send changes. Sous drafts the pull request.",
                run: () => {
                  const f = files.find((x) => x.display.endsWith("about-speaking-plainly/SKILL.tpl.md")) ?? files.find((x) => x.origin.kind === "recipe")
                  if (f) open(f.id)
                },
              },
            ].map((t) => (
              <button key={t.title} onClick={t.run} className="group rounded-xl border bg-card p-4 text-left transition hover:border-brand/50">
                <t.icon className="size-5 text-brand" />
                <div className="mt-2 text-sm font-semibold">{t.title}</div>
                <p className="mt-1 text-xs text-muted-foreground">{t.body}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand opacity-80 group-hover:opacity-100">
                  Start <ArrowRightIcon className="size-3" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}
