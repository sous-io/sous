// REAL: the signed-in GitHub account's pull requests on every repository this
// project draws from (its recipe repositories and its own), read with
// `gh pr list --author @me`. Nothing here writes to GitHub.

import { api } from "@/lib/api"
import { useCallback, useEffect, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LoaderCircleIcon,
  MessageSquareWarningIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { RepoAvatar } from "@/components/contribute/avatar"
import { cn } from "@/lib/utils"

type PrState = "open" | "draft" | "merged" | "closed"
type MyPr = {
  number: number
  title: string
  state: PrState
  branch: string
  url: string
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  review: "approved" | "changes" | "required" | null
  checks: { passing: number; failing: number; pending: number; skipped: number }
  additions: number
  deletions: number
  changedFiles: number
  madeWithSous: boolean
}
type MyPrsRepo = { key: string; owner: string; repo: string; role: "recipes" | "project"; ok: boolean; error?: string; prs: MyPr[] }
type MyPrs = {
  gh: { installed: boolean; signedIn: boolean; account?: string; host: string; message: string }
  repos: MyPrsRepo[]
  ms: number
  at: string
}

function fetchMyPrs(fresh: boolean): Promise<MyPrs> {
  return api.myPrs<MyPrs>(fresh)
}

function ago(iso: string | null | undefined): string {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24
  if (d < 30) return `${Math.floor(d)}d ago`
  const mo = d / 30
  if (mo < 12) return `${Math.floor(mo)}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

const STATE: Record<PrState, { label: string; icon: typeof CircleDotIcon; chip: string; icon_: string }> = {
  open: { label: "Open", icon: GitPullRequestArrowIcon, chip: "bg-success/12 text-success", icon_: "text-success" },
  draft: { label: "Draft", icon: GitPullRequestDraftIcon, chip: "bg-muted text-muted-foreground", icon_: "text-muted-foreground" },
  merged: { label: "Merged", icon: GitMergeIcon, chip: "bg-brand-2/12 text-brand-2", icon_: "text-brand-2" },
  closed: { label: "Closed", icon: GitPullRequestClosedIcon, chip: "bg-destructive/10 text-destructive", icon_: "text-destructive" },
}

function Checks({ c }: { c: MyPr["checks"] }) {
  const total = c.passing + c.failing + c.pending
  if (!total && !c.skipped) return <span className="text-muted-foreground/70">no checks</span>
  if (c.failing)
    return (
      <span className="flex items-center gap-1 text-destructive" title={`${c.failing} failing, ${c.passing} passing, ${c.pending} pending`}>
        <XIcon className="size-3" strokeWidth={3} /> {c.failing} failing
      </span>
    )
  if (c.pending)
    return (
      <span className="flex items-center gap-1 text-warning" title={`${c.pending} pending, ${c.passing} passing`}>
        <LoaderCircleIcon className="size-3 animate-spin" /> {c.pending} running
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-success" title={`${c.passing} passing${c.skipped ? `, ${c.skipped} skipped` : ""}`}>
      <CheckIcon className="size-3" strokeWidth={3} /> {total === 1 ? "check passed" : `${total} checks passed`}
    </span>
  )
}

function Review({ r, state }: { r: MyPr["review"]; state: PrState }) {
  if (state === "merged" || state === "closed") return null
  if (r === "approved")
    return (
      <span className="flex items-center gap-1 text-success">
        <UserCheckIcon className="size-3" /> approved
      </span>
    )
  if (r === "changes")
    return (
      <span className="flex items-center gap-1 text-warning">
        <MessageSquareWarningIcon className="size-3" /> changes requested
      </span>
    )
  if (r === "required")
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <ShieldCheckIcon className="size-3" /> review required
      </span>
    )
  return null
}

function PrRow({ pr }: { pr: MyPr }) {
  const s = STATE[pr.state]
  const when = pr.state === "merged" ? `merged ${ago(pr.mergedAt)}` : pr.state === "closed" ? `closed ${ago(pr.updatedAt)}` : `opened ${ago(pr.createdAt)}`
  const live = pr.state === "open" || pr.state === "draft"
  return (
    <div className={cn("group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40", live && "bg-success/[0.03]")}>
      <s.icon className={cn("mt-0.5 size-4 shrink-0", s.icon_)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-[13.5px] leading-snug font-medium hover:text-brand hover:underline">
            {pr.title} <span className="text-xs font-normal text-muted-foreground tabular-nums">#{pr.number}</span>
          </a>
          {pr.madeWithSous && (
            <span className="flex items-center gap-1 rounded-full bg-brand/12 px-1.5 py-px text-[10.5px] font-semibold text-brand" title={`Branch ${pr.branch} was made by the sous Send flow`}>
              <SparklesIcon className="size-2.5" /> made with sous
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className={cn("rounded-full px-1.5 py-px text-[10.5px] font-semibold", s.chip)}>{s.label}</span>
          <span className="flex max-w-44 items-center gap-1 truncate font-mono text-[11px]" title={pr.branch}>
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{pr.branch}</span>
          </span>
          <span>{when}</span>
          <Review r={pr.review} state={pr.state} />
          <Checks c={pr.checks} />
          <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums" title={`${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"} changed`}>
            <span className="text-success">+{pr.additions}</span>
            <span className="text-destructive">−{pr.deletions}</span>
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <FileDiffIcon className="size-3" />
              {pr.changedFiles}
            </span>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center pt-0.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ size: "xs", variant: "outline" }), "opacity-70 transition group-hover:opacity-100")}
          title={pr.url}
        >
          <ExternalLinkIcon /> Open on GitHub
        </a>
      </div>
    </div>
  )
}

const FOLD = 4

type Filter = "all" | "open" | "sous"
const matches = (p: MyPr, f: Filter) => f === "all" || (f === "open" ? p.state === "open" || p.state === "draft" : p.madeWithSous)

function RepoCard({ r: repo, filter }: { r: MyPrsRepo; filter: Filter }) {
  const [all, setAll] = useState(false)
  const r = { ...repo, prs: repo.prs.filter((p) => matches(p, filter)) }
  const live = r.prs.filter((p) => p.state === "open" || p.state === "draft")
  const rest = r.prs.filter((p) => p.state !== "open" && p.state !== "draft")
  const liveAll = repo.prs.filter((p) => p.state === "open" || p.state === "draft").length
  const merged = repo.prs.filter((p) => p.state === "merged").length
  const sous = repo.prs.filter((p) => p.madeWithSous).length
  const shownRest = all ? rest : rest.slice(0, Math.max(0, FOLD - live.length))
  const hidden = rest.length - shownRest.length
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex items-center gap-3 border-b bg-muted/25 px-4 py-3">
        <RepoAvatar owner={r.owner} className="size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a href={`https://github.com/${r.key}/pulls?q=is%3Apr+author%3A%40me`} target="_blank" rel="noreferrer" className="truncate text-[13.5px] font-semibold hover:underline">
              {r.key}
            </a>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-medium",
                r.role === "recipes" ? "bg-recipe/12 text-recipe" : "bg-muted text-muted-foreground",
              )}
            >
              {r.role === "recipes" ? "recipe repository" : "this project"}
            </span>
          </div>
          {r.ok && repo.prs.length > 0 && (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">
              {liveAll ? <b className="font-medium text-success">{liveAll} open</b> : "nothing open"} · {merged} merged
              {repo.prs.length >= 20 ? " · your latest 20" : ""}
              {sous ? ` · ${sous} made with sous` : ""}
            </div>
          )}
        </div>
      </div>
      {!r.ok ? (
        <div className="flex items-center gap-2 px-4 py-3.5 text-xs text-destructive">
          <CircleAlertIcon className="size-3.5 shrink-0" /> {r.error}
        </div>
      ) : r.prs.length === 0 ? (
        <div className="flex items-center gap-2.5 px-4 py-4 text-[13px] text-muted-foreground">
          <CircleSlashIcon className="size-4 shrink-0 opacity-60" />
          {repo.prs.length === 0
            ? `No pull requests by you on ${r.key} yet.`
            : filter === "open"
              ? `Nothing open on ${r.key} right now.`
              : `None of your pull requests on ${r.key} came from sous yet.`}
        </div>
      ) : (
        <div className="divide-y">
          {[...live, ...shownRest].map((p) => (
            <PrRow key={p.number} pr={p} />
          ))}
          {rest.length > Math.max(0, FOLD - live.length) && (
            <button
              onClick={() => setAll((v) => !v)}
              className="flex w-full items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
            >
              <ChevronDownIcon className={cn("size-3.5 transition", all && "rotate-180")} />
              {all ? "Show fewer" : `Show ${hidden} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SkeletonCard({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b bg-muted/25 px-4 py-3">
        <Skeleton className="size-8 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-2.5 w-28" />
        </div>
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5" style={{ width: `${70 - i * 12}%` }} />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
            <Skeleton className="h-6 w-28" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function MyPullRequests() {
  const [data, setData] = useState<MyPrs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [, tick] = useState(0)
  const [filter, setFilter] = useState<Filter>("all")

  const load = useCallback((fresh: boolean) => {
    setLoading(true)
    setError(null)
    fetchMyPrs(fresh)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => load(false), [load])
  // Keep "refreshed Xm ago" honest.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const signedOut = data && !data.gh.signedIn
  const all = data?.repos.flatMap((r) => r.prs) ?? []
  const openCount = all.filter((p) => p.state === "open" || p.state === "draft").length
  const sousCount = all.filter((p) => p.madeWithSous).length

  return (
    <section className="space-y-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Your pull requests on GitHub
            {data?.gh.signedIn && (
              <span className="flex items-center gap-1 rounded-full bg-success/12 px-1.5 py-px text-[10px] font-semibold tracking-wide text-success uppercase">
                <span className="size-1.5 rounded-full bg-success" /> live
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data?.gh.signedIn ? (
              <>
                By <b className="font-medium text-foreground">@{data.gh.account}</b> on the repos this project uses · {ago(data.at)}
              </>
            ) : (
              "Read with gh pr list, on the repositories this project uses. Nothing here writes to GitHub."
            )}
          </p>
        </div>
        {all.length > 0 && (
          <div className="flex items-center rounded-lg border bg-muted/30 p-0.5 text-[11.5px]">
            {(
              [
                ["all", "All", all.length],
                ["open", "Open", openCount],
                ["sous", "Made with sous", sousCount],
              ] as const
            ).map(([k, label, n]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-0.5 transition",
                  filter === k ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k === "sous" && <SparklesIcon className="size-3 text-brand" />}
                {label} <span className="text-muted-foreground tabular-nums">{n}</span>
              </button>
            ))}
          </div>
        )}
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => load(true)} disabled={loading}>
          <RefreshCwIcon className={cn(loading && "animate-spin")} /> {loading && data ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" /> Asking GitHub with <code className="font-mono">gh pr list --author @me</code>…
          </p>
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/6 p-4 text-sm">
          <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Couldn't load your pull requests</div>
            <div className="text-xs text-muted-foreground">{error}</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => load(true)}>
            Try again
          </Button>
        </div>
      ) : signedOut ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/6 p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
            <TerminalIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{data.gh.installed ? "gh isn't signed in" : "The GitHub CLI (gh) isn't installed"}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              sous reads your pull requests with <code className="font-mono">gh</code>. Sign in, then refresh:
            </div>
            <code className="mt-2 inline-block rounded-md border bg-background px-2 py-1 font-mono text-xs">gh auth login --hostname {data.gh.host}</code>
          </div>
          <Button size="sm" variant="outline" onClick={() => load(true)}>
            <RefreshCwIcon /> Refresh
          </Button>
        </div>
      ) : data && data.repos.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          This project doesn't use any recipe repository on GitHub, and its own remote isn't on GitHub.
        </div>
      ) : (
        <div className={cn("space-y-3 transition-opacity", loading && "opacity-60")}>
          {data?.repos.map((r) => (
            <RepoCard key={r.key} r={r} filter={filter} />
          ))}
        </div>
      )}
    </section>
  )
}
