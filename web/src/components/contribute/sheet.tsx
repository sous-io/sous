// One proposal per destination: the review sheet, then the run, then the result.

import { useEffect, useMemo, useRef, useState } from "react"
import DOMPurify from "dompurify"
import { marked } from "marked"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestArrowIcon,
  HardDriveDownloadIcon,
  KeyRoundIcon,
  PackageIcon,
  SparklesIcon,
  TerminalIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { contributionBranch, type BumpKind, type Proposal } from "@/mock/data"
import { FileChange } from "./diff-view"
import {
  addedLines,
  changelogFor,
  claudeBody,
  commitMessage,
  defaultBody,
  defaultTitle,
  genericHits,
  mergeOntoUpstream,
  planVersion,
  relTime,
  replaceOnLine,
  stepsFor,
  targetVersion,
  useContributeInfo,
  usePrNumbers,
  type Group,
  type VersionPlan,
} from "./model"
import { Preflight, type Check } from "./preflight"
import { RunView } from "./run"
import { RepoAvatar } from "./avatar"
import { useUndeclared } from "@/components/undeclared"
import type { WorkspaceFile } from "@/lib/api"

type Undeclared = { name: string; declaredBy: string | null }

/** Runs the real undeclared-variable check for one file and reports it up. */
function CollectUndeclared({ file, onResult }: { file: WorkspaceFile; onResult: (id: string, found: Undeclared[]) => void }) {
  const found = useUndeclared(file)
  const key = JSON.stringify(found)
  useEffect(() => onResult(file.id, found), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function Section({ n, title, aside, children }: { n: number; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="grid size-5 place-items-center rounded-full bg-foreground/8 text-[11px] font-semibold text-muted-foreground">{n}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

function Segmented({ value, options, onChange }: { value: BumpKind; options: { key: BumpKind; label: string; version: string }[]; onChange: (k: BumpKind) => void }) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "flex items-baseline gap-1.5 rounded-md px-2.5 py-1 text-xs transition-all",
            value === o.key ? "bg-brand text-white shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground",
          )}
        >
          <span className="font-medium">{o.label}</span>
          <span className={cn("font-mono text-[10.5px]", value === o.key ? "text-white/85" : "text-muted-foreground/80")}>{o.version}</span>
        </button>
      ))}
    </div>
  )
}

function VersionRow({ plan, kind, onChange }: { plan: VersionPlan; kind: BumpKind; onChange: (k: BumpKind) => void }) {
  const to = targetVersion(plan, kind)
  return (
    <div className="space-y-2 rounded-lg border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <PackageIcon className="size-4 text-recipe" />
        <span className="text-[13px] font-medium">{plan.recipe}</span>
        {plan.alreadyRaised ? (
          <span className="font-mono text-xs text-muted-foreground">
            {plan.base} <span className="font-sans">({plan.raisedIn ? `raised in #${plan.raisedIn}` : "already raised upstream, not released yet"})</span>
          </span>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {plan.base} <ArrowRightIcon className="inline size-3" /> <b className="text-foreground">{to}</b>
          </span>
        )}
        {!plan.alreadyRaised && (
          <div className="ml-auto">
            <Segmented
              value={kind}
              onChange={onChange}
              options={(["patch", "minor", "major"] as BumpKind[]).map((k) => ({
                key: k,
                label: k[0].toUpperCase() + k.slice(1),
                version: targetVersion(plan, k),
              }))}
            />
          </div>
        )}
      </div>
      <div className="space-y-1 pl-7 text-xs text-muted-foreground">
        {plan.alreadyRaised ? (
          <p>
            {plan.raisedIn
              ? `#${plan.raisedIn} already raises it to ${plan.base}. More commits on the same proposal don't need another raise.`
              : "Someone already raised it on main and it isn't released yet, so this proposal leaves the version alone."}
          </p>
        ) : (
          <p>
            <SparklesIcon className="mr-1 inline size-3 text-liquid" />
            Suggested <b className="text-foreground">{plan.suggested}</b>: {plan.reason}.
            {kind !== plan.suggested && (
              <button className="ml-1.5 text-brand hover:underline" onClick={() => onChange(plan.suggested)}>
                Use the suggestion
              </button>
            )}
          </p>
        )}
        {!plan.raisedIn && (
        <p>
          {plan.baseSource === "head"
            ? `Counted from ${plan.base}, the version on upstream main`
            : plan.baseSource === "released"
              ? `Counted from ${plan.base}, the newest release`
              : `Counted from ${plan.base}, the version you use (upstream couldn't be reached)`}
          {plan.pinned !== plan.base && `, not ${plan.pinned}, the one you use`}.{" "}
        </p>
        )}
        {!plan.alreadyRaised && (
          <div className="mt-1.5 inline-flex overflow-hidden rounded-md border font-mono text-[11px]">
            <span className="border-r bg-muted/50 px-2 py-0.5 text-muted-foreground">{plan.manifestPath}</span>
            <span className="diff-del px-2 py-0.5 text-muted-foreground line-through">version: {plan.base}</span>
            <span className="diff-add px-2 py-0.5 text-foreground">version: {to}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return (
    <div
      className="text-[13px] leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2:first-child]:mt-0 [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5 [&_strong]:font-semibold"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ProposalSheet({ group, onDone, next }: { group: Group; onDone: (p: Proposal | null, stats?: { added: number; removed: number }) => void; next?: { label: string; go: () => void } }) {
  const docs = useStore((s) => s.docs)
  const proposals = useStore((s) => s.proposals)
  const projectName = useStore((s) => s.workspace?.projectName ?? "this project")
  const { info, loading, secretHits, scanSecrets } = useContributeInfo()

  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const files = group.files.filter((f) => !excluded.has(f.id))
  const pairs = files.map((f) => ({ f, doc: docs[f.id] }))
  const repoInfo = info?.repos[group.key]
  const baseBranch = repoInfo?.defaultBranch ?? "main"

  // An open proposal for this destination that these files were already sent in.
  const openProposal = proposals.find(
    (p) => !p.example && p.repo === group.key && p.stage !== "merged" && p.stage !== "released" && group.files.some((f) => docs[f.id]?.proposedIn === p.id),
  )
  const [mode, setMode] = useState<"add" | "new">(openProposal ? "add" : "new")
  const addTo = mode === "add" ? openProposal : undefined

  const freshTitle = () => defaultTitle(group, group.files)
  // Prefilled with the plain facts from the diff, so one click can propose; "Write it with Claude" adds structure.
  const freshBody = () => defaultBody(group.files.filter((f) => docs[f.id]).map((f) => ({ f, doc: docs[f.id] })))
  const [title, setTitle] = useState(() => (openProposal ? openProposal.title : freshTitle()))
  const [body, setBody] = useState(() => (openProposal ? (openProposal.description ?? freshBody()) : freshBody()))
  // Adding to an open proposal: one commit message, and the PR description only if you ask.
  const [commit, setCommit] = useState(() => commitMessage(group.files.filter((f) => docs[f.id]).map((f) => ({ f, doc: docs[f.id] }))))
  const [editDesc, setEditDesc] = useState(false)
  const loadNumbers = usePrNumbers((s) => s.load)
  useEffect(() => {
    if (group.kind === "pr" || group.kind === "core") loadNumbers()
  }, [group.kind, loadNumbers])
  const [undoBody, setUndoBody] = useState<string | null>(null)
  const [descTab, setDescTab] = useState<"write" | "preview">("write")
  const [writing, setWriting] = useState(false)
  const [bumps, setBumps] = useState<Record<string, BumpKind>>({})
  const [draft, setDraft] = useState(false)
  const [branch, setBranch] = useState(() => openProposal?.branch ?? contributionBranch())
  const [phase, setPhase] = useState<"review" | "running">("review")
  const [undeclared, setUndeclared] = useState<Record<string, Undeclared[]>>({})
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const merges = useMemo(
    () => Object.fromEntries(group.files.map((f) => [f.id, mergeOntoUpstream(docs[f.id], info?.files[f.id]?.upstream)])),
    [group.files, docs, info],
  )
  const plans = useMemo(
    () =>
      group.kind === "pr"
        ? group.recipes
            .map((r) => ({ r, own: pairs.filter((p) => p.f.origin.kind === "recipe" && `${p.f.origin.namespace}/${p.f.origin.recipe}` === r.name) }))
            .filter((x) => x.own.length)
            .map((x) => planVersion(x.r, x.own, info))
            .map((p) => {
              const raised = addTo?.recipes.find((r) => r.name === p.recipe)
              return raised ? { ...p, alreadyRaised: true, base: raised.to, raisedIn: addTo!.number } : p
            })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [group, docs, info, excluded, addTo],
  )
  const hits = useMemo(() => (group.kind === "pr" || group.kind === "core" ? pairs.flatMap(({ f, doc }) => genericHits(f, doc)) : []), [pairs, group.kind])
  const secrets = secretHits.filter((h) => files.some((f) => f.id === h.id))

  // The secret scan runs on the server, which knows the values; only names come back.
  const addedKey = pairs.map((p) => p.doc.current).join("\u0000")
  useEffect(() => {
    if (group.kind === "sample") return
    const added = Object.fromEntries(pairs.map(({ f, doc }) => [f.id, addedLines(doc.original, doc.current).map((l) => l.text)]))
    scanSecrets(added)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedKey])

  const conflicts = files.filter((f) => merges[f.id]?.state === "conflict")
  const ahead = group.recipes
    .map((r) => ({ r, latest: info?.recipes[r.name]?.latestReleased }))
    .filter((x) => x.latest && x.latest !== x.r.pinned)

  const replace = (hit: (typeof hits)[number]) => {
    const doc = useStore.getState().docs[hit.id]
    const next = replaceOnLine(doc.current, hit.line, hit.value, hit.name)
    useStore.getState().edit(hit.id, next)
    api.render(hit.id, next, doc.overrides).then((r) => useStore.getState().setRender(hit.id, next, r))
    toast.success(`Replaced with {{ ${hit.name} }}`, { description: `${hit.file}, line ${hit.line}` })
  }

  const writeWithClaude = () => {
    const text = claudeBody(pairs)
    setUndoBody(body)
    setWriting(true)
    setDescTab("write")
    setBody("")
    let i = 0
    const tick = window.setInterval(() => {
      i += 5
      setBody(text.slice(0, i))
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      if (i >= text.length) {
        window.clearInterval(tick)
        setWriting(false)
      }
    }, 14)
  }

  // ---- checks ----
  const checks: Check[] = []
  if (group.kind === "pr" || group.kind === "core") {
    const gh = info?.gh
    checks.push(
      gh?.signedIn
        ? { key: "gh", state: "ok", title: <>GitHub CLI signed in as <b>{gh.account ?? "you"}</b></>, source: "gh auth status" }
        : {
            key: "gh",
            state: "stop",
            title: gh?.installed === false ? "The GitHub CLI (gh) isn't installed" : "Sign in to GitHub first",
            detail: (
              <>
                Run <code className="rounded bg-muted px-1 font-mono">gh auth login</code> in a terminal, then check again.
              </>
            ),
            action: (
              <Button size="xs" variant="outline" onClick={() => useContributeInfo.getState().load(group.files.map((f) => f.id))}>
                Check again
              </Button>
            ),
            source: "gh auth status",
          },
    )
    const push = group.kind === "core" ? info?.recipes[group.recipes[0]?.name]?.redirect?.canPush : repoInfo?.canPush
    checks.push(
      push === false
        ? {
            key: "push",
            state: "ok",
            title: (
              <>
                You can't push to {group.title}, so sous uses your fork <b>{gh?.account ?? "you"}/{group.repo}</b>
              </>
            ),
            detail: "It's created for you if it doesn't exist yet.",
            source: "gh api",
          }
        : push
          ? { key: "push", state: "ok", title: <>You can push to <b>{group.title}</b>, so the branch goes there directly. No fork needed.</>, source: "gh api" }
          : { key: "push", state: "info", title: "Push access will be checked when proposing", detail: "If you can't push, sous forks the repository for you." },
    )
    if (group.kind === "core")
      checks.push({
        key: "route",
        state: "ok",
        title: (
          <>
            Routed to <b>{group.title}</b>, because {group.recipes.map((r) => r.name).join(", ")} doesn't take proposals in {group.from}
          </>
        ),
        detail: (
          <>
            Its manifest says <i>“{group.instead ?? `Propose changes in ${group.title}, under ${group.intoPath}`}”</i> Your edits go to{" "}
            <code className="font-mono">{group.intoPath}</code> there.
          </>
        ),
        source: "submissions.allowed: false",
      })
    if (repoInfo?.head)
      checks.push({
        key: "head",
        state: "ok",
        title: (
          <>
            Upstream {baseBranch} is at <code className="font-mono text-xs">{repoInfo.head.sha}</code>, {relTime(repoInfo.head.date)}
          </>
        ),
        detail: (
          <>
            “{repoInfo.head.message}”
            {ahead.length > 0 &&
              ` · You use ${ahead.map((a) => `${a.r.name} ${a.r.pinned}`).join(", ")}; upstream has released ${ahead.map((a) => a.latest).join(", ")} since.`}
          </>
        ),
        source: "gh api",
      })
    checks.push(
      conflicts.length
        ? {
            key: "merge",
            state: "stop",
            title: `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed upstream in the same place you edited`,
            detail: "Resolve the conflict first. (The conflict editor isn't part of this proof of concept.)",
          }
        : {
            key: "merge",
            state: "ok",
            title: files.some((f) => merges[f.id]?.state === "clean")
              ? `Your edits merge cleanly onto upstream ${baseBranch}`
              : files.some((f) => merges[f.id]?.state === "same")
                ? `Your edits apply as they are: upstream hasn't touched ${files.length === 1 ? "this file" : "these files"}`
                : "Your edits will be applied onto upstream",
            detail: files.some((f) => merges[f.id]?.state === "clean") ? "Upstream changed these files since your version. The diff below is against upstream." : undefined,
            source: "3-way merge",
          },
    )
    checks.push(
      secrets.length
        ? {
            key: "generic",
            state: "stop",
            title: (
              <>
                Your change contains the value of <b>{secrets[0].name}</b>, which is a secret
              </>
            ),
            detail: "It can't be sent. Remove it, or use the variable instead.",
          }
        : hits.length
          ? {
              key: "generic",
              state: "warn",
              title: `${hits.length} added line${hits.length === 1 ? "" : "s"} contain${hits.length === 1 ? "s" : ""} this project's own values`,
              detail: "Every subscriber gets this recipe. Use the variable so it fits their project too. See below.",
            }
          : { key: "generic", state: "ok", title: "Generic: no project-specific values in your added lines", source: "your variables" },
    )
    const missingVars = files.flatMap((f) => (undeclared[f.id] ?? []).map((u) => ({ ...u, file: f })))
    checks.push(
      missingVars.length
        ? {
            key: "undeclared",
            state: "warn",
            title: (
              <>
                {missingVars.length === 1 ? "A variable is" : `${missingVars.length} variables are`} read but not declared:{" "}
                {missingVars.map((m, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    <code className="font-mono text-xs text-liquid">{m.name}</code>
                  </span>
                ))}
              </>
            ),
            detail: missingVars[0].declaredBy
              ? `${missingVars[0].name} is declared by ${missingVars[0].declaredBy}, which this recipe doesn't depend on. Other subscribers get an empty value.`
              : "It works for you because your project sets it. Every other subscriber gets an empty value. Declare it in sous.recipe.yaml.",
            source: "liquid analysis",
          }
        : { key: "undeclared", state: "ok", title: "Every variable your edit reads is declared by the recipe", source: "liquid analysis" },
    )
    if (group.kind === "pr")
      checks.push(
        plans.length
          ? {
              key: "version",
              state: "ok",
              title: plans.every((p) => p.alreadyRaised)
                ? addTo
                  ? `Version already raised in #${addTo.number}`
                  : "Versions already raised upstream"
                : `Version raised for ${plans.length === 1 ? plans[0].recipe : `all ${plans.length} recipes`}, so the release after merge can publish it`,
              source: "release --ci",
            }
          : { key: "version", state: "info", title: "No recipe files selected" },
      )
    if (group.kind === "core")
      checks.push({ key: "version", state: "ok", title: "No version raise: core/sous-skills follows the sous release", source: "core" })
    checks.push(
      { key: "index", state: "ok", title: <>sous.index.json untouched: only the release writes it</>, source: "submit" },
      {
        key: "git",
        state: info?.git.userName ? "ok" : "warn",
        title: info?.git.userName ? (
          <>
            Commits as {info.git.userName} <span className="text-muted-foreground">&lt;{info.git.userEmail}&gt;</span>
          </>
        ) : (
          "Git has no user.name or user.email set"
        ),
        source: "git config",
      },
      {
        key: "validate",
        state: "info",
        title: "The repository's own checks run once it's linked",
        detail: (
          <>
            <code className="font-mono">sous repo release --check</code>, the same check the pull request runs.
            {repoInfo?.contribute && (
              <>
                {" "}
                Their guide:{" "}
                <a href={repoInfo.contribute} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  {repoInfo.contribute.replace(/^https:\/\/(github\.com\/)?/, "")}
                </a>
              </>
            )}
          </>
        ),
      },
    )
  }

  const blocked = checks.some((c) => c.state === "stop")
  const needsBody = !addTo && (group.kind === "pr" || group.kind === "core")
  const sentOf = (id: string) => (addTo && docs[id]?.proposedIn === addTo.id && docs[id]?.proposedContent != null ? docs[id].proposedContent! : null)
  const canPush = group.kind === "core" ? (info?.recipes[group.recipes[0]?.name]?.redirect?.canPush ?? null) : (repoInfo?.canPush ?? null)
  const headRepo = canPush === false ? `${info?.gh.account ?? "you"}/${group.repo}` : group.title
  const changelog = changelogFor(group, plans, bumps, baseBranch)
  const missing = addTo && !commit.trim() ? "a commit message" : !title.trim() ? "a title" : needsBody && !body.trim() ? "a description" : files.length === 0 ? "a file" : null

  const steps = stepsFor({
    group,
    branch,
    canPush,
    account: info?.gh.account,
    baseBranch,
    headSha: repoInfo?.head?.sha,
    plans,
    bumps,
    title: addTo ? commit : title,
    draft,
    fileCount: files.length,
    addTo: addTo ? { number: addTo.number, branch: addTo.branch } : undefined,
  })

  const sentence =
    group.kind === "project" ? (
      <>
        Writes {files.length} file{files.length === 1 ? "" : "s"} in {projectName}. Git is yours: commit {files.length === 1 ? "it" : "them"} however you like.
      </>
    ) : addTo ? (
      <>
        Pushes your edits to <code className="font-mono">{addTo.branch}</code> and updates <b>#{addTo.number}</b> on {group.title}.
      </>
    ) : (
      <>
        Opens a {draft ? "draft " : ""}pull request from{" "}
        <code className="font-mono">
          {headRepo}:{branch}
        </code>{" "}
        into{" "}
        <code className="font-mono">
          {group.title}:{baseBranch}
        </code>
        .
      </>
    )

  const run = () => setPhase("running")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && phase === "review" && !blocked && !missing) run()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (phase === "running")
    return (
      <RunView
        group={group}
        steps={steps}
        files={files}
        title={addTo && !editDesc ? addTo.title : title}
        body={addTo && !editDesc ? (addTo.description ?? body) : body}
        draft={draft}
        branch={addTo?.branch ?? branch}
        headRepo={headRepo}
        baseBranch={baseBranch}
        recipes={plans.map((p) => ({ name: p.recipe, from: p.base, to: targetVersion(p, bumps[p.recipe]) }))}
        addTo={addTo}
        onDone={onDone}
        next={next}
      />
    )

  if (group.kind === "sample")
    return (
      <div className="space-y-4 p-7">
        <div className="text-base font-semibold">The POC sample isn't a real file</div>
        <p className="text-sm text-muted-foreground">
          It lives only in this server's memory, so there is nowhere to send it. Edit a recipe file (any <code>.tpl.md</code> under Recipes) to try the
          upstream flow.
        </p>
      </div>
    )

  let n = 0
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-7 px-7 pt-6 pb-8">
        {/* Header */}
        <div className="flex items-start gap-3.5">
          {group.kind === "project" ? (
            <span className="grid size-11 place-items-center rounded-lg bg-project/15 text-project">
              <HardDriveDownloadIcon className="size-5" />
            </span>
          ) : (
            <RepoAvatar owner={group.owner} className="size-11" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                {group.kind === "project" ? `Save in ${group.title}` : addTo ? `Propose to #${addTo.number}` : `Propose to ${group.title}`}
              </h2>
              {group.kind === "core" && <span className="rounded-full bg-brand/12 px-2 py-0.5 text-[11px] font-medium text-brand">core recipe</span>}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {group.kind === "project"
                ? "These are your project's own files. Sous saves them; there's nothing to propose."
                : addTo
                  ? `“${addTo.title}” is still open, so these edits go in as a new commit on it instead of a second pull request.`
                  : "You decide what, why and how big. Sous does the checkout, branch, commit, push and pull request."}
            </p>
            {openProposal && (
              <button
                className="mt-1 text-xs text-brand hover:underline"
                onClick={() => {
                  const toNew = mode === "add"
                  setMode(toNew ? "new" : "add")
                  setTitle(toNew ? freshTitle() : openProposal.title)
                  setBody(toNew ? freshBody() : (openProposal.description ?? freshBody()))
                }}
              >
                {mode === "add" ? "Start a new proposal instead" : `Propose to #${openProposal.number} instead`}
              </button>
            )}
          </div>
        </div>

        {group.kind !== "project" &&
          files.map((f) => (
            <CollectUndeclared key={f.id} file={f} onResult={(id, found) => setUndeclared((u) => ({ ...u, [id]: found }))} />
          ))}
        {group.kind !== "project" && <Preflight checks={checks} loading={loading && !info} />}

        {/* Make it generic */}
        {hits.length > 0 && (
          <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/6 p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <WandSparklesIcon className="size-4 text-warning" /> Make it generic
            </div>
            <p className="text-xs text-muted-foreground">These are your values. Other projects have their own, so the recipe should use the variable.</p>
            {hits.map((h, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11.5px]">
                    {h.text.split(h.value).map((part, j, all) => (
                      <span key={j}>
                        {part}
                        {j < all.length - 1 && <mark className="rounded bg-warning/30 px-0.5 text-foreground">{h.value}</mark>}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {h.file.split("/").slice(-2).join("/")}, line {h.line} · “{h.value}” is your value of <b>{h.name}</b>
                  </div>
                </div>
                <Button size="xs" variant="outline" onClick={() => replace(h)}>
                  Replace with <code className="font-mono text-liquid">{`{{ ${h.name} }}`}</code>
                </Button>
              </div>
            ))}
          </div>
        )}
        {secrets.length > 0 && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/50 bg-destructive/6 p-4">
            <KeyRoundIcon className="mt-0.5 size-4 text-destructive" />
            <div className="text-[13px]">
              {secrets.map((s, i) => (
                <p key={i}>
                  Line {s.line + 1} of your added text contains the value of <b>{s.name}</b> (secret). It cannot be sent.
                </p>
              ))}
            </div>
          </div>
        )}

        <Section
          n={++n}
          title={group.kind === "project" ? "What you're saving" : "What you're proposing"}
          aside={
            <span className="text-xs text-muted-foreground">
              {files.length} of {group.files.length} file{group.files.length === 1 ? "" : "s"}
            </span>
          }
        >
          <div className="space-y-2">
            {group.files.map((f) => (
              <FileChange
                key={f.id}
                file={f}
                doc={docs[f.id]}
                merge={merges[f.id]}
                included={!excluded.has(f.id)}
                canExclude={files.length > 1}
                onToggle={(v) => {
                  const next = new Set(excluded)
                  if (v) next.delete(f.id)
                  else next.add(f.id)
                  setExcluded(next)
                }}
                defaultOpen={group.files.length <= 2}
                baseBranch={baseBranch}
                sent={sentOf(f.id) != null ? { content: sentOf(f.id)!, number: addTo!.number } : undefined}
              />
            ))}
          </div>
        </Section>

        {group.kind !== "project" && addTo && (
          <Section
            n={++n}
            title="Commit message"
            aside={
              !editDesc && (
                <button className="text-xs text-brand hover:underline" onClick={() => setEditDesc(true)}>
                  Edit the pull request's description
                </button>
              )
            }
          >
            <div className="space-y-1.5">
              <Input value={commit} onChange={(e) => setCommit(e.target.value)} className="text-[13px]" aria-label="Commit message" />
              <p className="px-1 text-[11px] text-muted-foreground">
                Added to #{addTo.number} as one commit. Its title and description stay as they are{editDesc ? " unless you change them below" : ""}.
              </p>
            </div>
          </Section>
        )}

        {group.kind !== "project" && (!addTo || editDesc) && (
          <Section n={++n} title={addTo ? `Title and description of #${addTo.number}` : "Title and description"}>
            <div className="space-y-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="font-medium" aria-label="Title" />
              <div className="overflow-hidden rounded-lg border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                <div className="flex items-center gap-1 border-b bg-muted/30 px-1.5 py-1">
                  {(["write", "preview"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setDescTab(t)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-xs capitalize",
                        descTab === t ? "bg-background font-medium shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    {undoBody !== null && !writing && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setBody(undoBody)
                          setUndoBody(null)
                        }}
                      >
                        <Undo2Icon /> Undo
                      </Button>
                    )}
                    <Button size="xs" variant="secondary" onClick={writeWithClaude} disabled={writing} className="border border-liquid/30 bg-liquid-soft text-liquid hover:bg-liquid/15">
                      <SparklesIcon className={cn(writing && "animate-pulse")} /> {writing ? "Writing…" : "Write it with Claude"}
                    </Button>
                  </div>
                </div>
                {descTab === "write" ? (
                  <Textarea
                    ref={bodyRef}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={7}
                    placeholder={"Why does this change help? What did your agent get wrong before?\n\nMarkdown works."}
                    className="min-h-36 resize-y rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0"
                  />
                ) : (
                  <div className="min-h-36 px-3 py-2">{body.trim() ? <Markdown text={body} /> : <p className="text-xs text-muted-foreground">Nothing to preview.</p>}</div>
                )}
              </div>
              {needsBody && !body.trim() && (
                <p className="text-[11px] text-muted-foreground">Required: sous never borrows a commit message for a new proposal.</p>
              )}
              <details className="group rounded-lg border bg-muted/20">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                  <FileTextIcon className="size-3.5" /> Sous adds this changelog under your description
                  <ChevronDownIcon className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t px-3 py-2 opacity-85">
                  <Markdown text={changelog} />
                </div>
              </details>
            </div>
          </Section>
        )}

        {group.kind === "pr" && plans.length > 0 && (
          <Section n={++n} title="New version">
            <div className="space-y-2">
              {plans.map((p) => (
                <VersionRow key={p.recipe} plan={p} kind={bumps[p.recipe] ?? p.suggested} onChange={(k) => setBumps({ ...bumps, [p.recipe]: k })} />
              ))}
              <p className={cn("px-1 text-[11px] text-muted-foreground", plans.every((p) => p.alreadyRaised) && "hidden")}>
                Patch: wording or a fix. Minor: something new that changes nothing existing. Major: something that breaks what subscribers have.
              </p>
            </div>
          </Section>
        )}

        {group.kind !== "project" && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" /> Options: draft, branch name, the commands
            </summary>
            <div className="mt-3 space-y-3 rounded-lg border p-3.5">
              {!addTo && (
                <label className="flex items-center gap-3 text-sm">
                  <Switch checked={draft} onCheckedChange={setDraft} /> Open it as a draft
                  <span className="text-xs text-muted-foreground">You can mark it ready later from Proposals.</span>
                </label>
              )}
              <label className="flex items-center gap-3 text-sm">
                <GitBranchIcon className="size-4 text-muted-foreground" />
                <span className="shrink-0">Branch</span>
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!!addTo} className="h-7 font-mono text-xs" />
              </label>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <TerminalIcon className="size-3.5" /> What sous runs for you
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => {
                      navigator.clipboard?.writeText(steps.map((s) => s.command).join("\n")).catch(() => {})
                      toast.success("Commands copied")
                    }}
                  >
                    <CopyIcon />
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {steps.map((s) => s.command).join("\n")}
                </pre>
              </div>
            </div>
          </details>
        )}
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 z-10 border-t bg-background/92 px-7 py-3.5 backdrop-blur">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            {blocked ? <span className="text-destructive">Fix the red item above to continue.</span> : missing ? <>Add {missing} to continue.</> : sentence}
            {group.kind !== "project" && !blocked && !missing && (
              <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] tracking-wide uppercase">simulated</span>
            )}
          </div>
          <Button size="lg" onClick={run} disabled={blocked || !!missing} className="shrink-0 bg-brand text-white shadow-[var(--shadow-glow)] hover:bg-brand/90">
            {group.kind === "project" ? <HardDriveDownloadIcon /> : canPush === false ? <GitForkIcon /> : <GitPullRequestArrowIcon />}
            {group.kind === "project"
              ? `Save ${files.length} file${files.length === 1 ? "" : "s"}`
              : addTo
                ? `Propose ${files.length} change${files.length === 1 ? "" : "s"} to #${addTo.number}`
                : `Propose ${files.length} change${files.length === 1 ? "" : "s"}`}
            <span className="ml-1 rounded bg-white/18 px-1 font-mono text-[10px]">Ctrl ↵</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
