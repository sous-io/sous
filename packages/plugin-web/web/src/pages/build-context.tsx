// Build and Agent context pages. Both are REAL: they come from a build of every
// target as a dry run (the web.build intent, src/intents/build.ts in the plugin).

import { useEffect, useMemo, useState } from "react"
import DOMPurify from "dompurify"
import { marked } from "marked"
import {
  BotIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  FileCode2Icon,
  FileOutputIcon,
  HammerIcon,
  LayersIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type OutputInfo } from "@/lib/api"
import { SkillGuess } from "@/components/skill-guess"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const STATUS: Record<OutputInfo["status"], { label: string; icon: typeof CheckCircle2Icon; cls: string; hint: string }> = {
  "up-to-date": { label: "up to date", icon: CheckCircle2Icon, cls: "text-success", hint: "The file on disk matches a fresh build." },
  stale: { label: "out of date", icon: TriangleAlertIcon, cls: "text-warning", hint: "A fresh build would change this file. Run sous build." },
  missing: { label: "not built", icon: CircleDashedIcon, cls: "text-muted-foreground", hint: "This file hasn't been written yet. Run sous build." },
  failed: { label: "fails", icon: CircleAlertIcon, cls: "text-destructive", hint: "sous build can't write this file." },
}

function StatusPill({ status }: { status: OutputInfo["status"] }) {
  const s = STATUS[status]
  const Icon = s.icon
  return (
    <span className={cn("flex items-center gap-1 text-xs whitespace-nowrap", s.cls)} title={s.hint}>
      <Icon className="size-3.5" /> {s.label}
    </span>
  )
}

function OutputSheet({ output, onClose }: { output: OutputInfo | null; onClose: () => void }) {
  const files = useStore((s) => s.workspace?.files ?? [])
  const open = useStore((s) => s.open)
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    setContent(null)
    if (output && output.status !== "failed") api.output(output.output).then((r) => setContent(r.content)).catch(() => setContent(""))
  }, [output])
  const html = useMemo(() => {
    if (!content) return ""
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "")
    return DOMPurify.sanitize(marked.parse(body, { async: false }) as string)
  }, [content])
  const sources = output ? output.sources.map((id) => files.find((f) => f.id === id)).filter(Boolean) : []

  return (
    <Sheet open={output !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(760px,92vw)] gap-0 sm:max-w-none">
        {output && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="font-mono text-sm">{output.output}</SheetTitle>
              <SheetDescription className="flex items-center gap-3">
                <StatusPill status={output.status} />
                <span>{output.tokens.toLocaleString()} tokens</span>
                <span>{(output.bytes / 1024).toFixed(1)} KB</span>
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-4">
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Built from {sources.length} file{sources.length === 1 ? "" : "s"}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sources.map((f) => (
                      <button
                        key={f!.id}
                        onClick={() => {
                          onClose()
                          open(f!.id)
                        }}
                        className="flex items-center gap-1 rounded-md border bg-card px-2 py-1 font-mono text-[11px] hover:border-brand hover:text-brand"
                      >
                        <FileCode2Icon className="size-3" /> {f!.display}
                      </button>
                    ))}
                  </div>
                </div>
                {output.status === "failed" ? (
                  <pre className="rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-xs whitespace-pre-wrap text-destructive">
                    {output.error}
                  </pre>
                ) : content === null ? (
                  <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <div className="md-preview rounded-lg border bg-card p-5" dangerouslySetInnerHTML={{ __html: html }} />
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function useBuild() {
  const build = useStore((s) => s.build)
  const building = useStore((s) => s.building)
  const rebuild = useStore((s) => s.rebuild)
  return { build, building, rebuild }
}

function Stat({ label, value, hint, cls }: { label: string; value: string | number; hint?: string; cls?: string }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-bold tracking-tight tabular-nums", cls)}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export function BuildPage() {
  const { build, building, rebuild } = useBuild()
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<OutputInfo | null>(null)
  if (!build) return <Loading />

  const counts = { "up-to-date": 0, stale: 0, missing: 0, failed: 0 }
  for (const o of build.outputs) counts[o.status]++
  const total = build.outputs.reduce((n, o) => n + o.tokens, 0)
  const max = Math.max(...build.outputs.map((o) => o.tokens), 1)
  const rows = build.outputs
    .filter((o) => o.output.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.status === "failed" ? -1 : 0) - (b.status === "failed" ? -1 : 0) || b.tokens - a.tokens)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-5 p-8">
        <div className="flex items-end gap-4">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <HammerIcon className="size-6 text-brand" /> Build
            </h1>
            <p className="text-sm text-muted-foreground">
              What <code className="rounded bg-muted px-1">sous build</code> would write right now, compared with what's on disk. A dry run
              of every output in {build.ms} ms; nothing in your project was touched.
            </p>
          </div>
          <Button className="ml-auto" onClick={rebuild} disabled={building}>
            {building ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />} Check again
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Outputs" value={build.outputs.length} hint={`${total.toLocaleString()} tokens`} />
          <Stat label="Up to date" value={counts["up-to-date"]} cls="text-success" />
          <Stat label="Out of date" value={counts.stale} cls={counts.stale ? "text-warning" : undefined} />
          <Stat label="Not built" value={counts.missing} hint={counts.missing ? "run sous build" : undefined} />
          <Stat label="Failing" value={counts.failed} cls={counts.failed ? "text-destructive" : undefined} />
        </div>
        {counts.failed > 0 && (
          <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/8 p-4 text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <div className="font-medium">
                {counts.failed} output{counts.failed === 1 ? "" : "s"} can't be built
              </div>
              {build.outputs
                .filter((o) => o.status === "failed")
                .map((o) => (
                  <button key={o.output} onClick={() => setSelected(o)} className="block text-left text-xs text-muted-foreground hover:text-foreground">
                    <span className="font-mono text-foreground">{o.output}</span>: {o.error?.split("\n")[0]}
                  </button>
                ))}
            </div>
          </div>
        )}
        <div className="relative w-72">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter outputs…" className="pl-8" />
        </div>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Output</TableHead>
                <TableHead className="w-24">Sources</TableHead>
                <TableHead className="w-56">Tokens</TableHead>
                <TableHead className="w-32">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.output} className="cursor-pointer" onClick={() => setSelected(o)}>
                  <TableCell className="font-mono text-xs">{o.output}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{o.sources.length}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-brand/70" style={{ width: `${(o.tokens / max) * 100}%` }} />
                      </div>
                      <span className="w-14 text-right text-xs tabular-nums">{o.tokens.toLocaleString()}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={o.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
      <OutputSheet output={selected} onClose={() => setSelected(null)} />
    </ScrollArea>
  )
}

function Loading() {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin" /> Building every output as a dry run…
      </span>
    </div>
  )
}

export function ContextPage() {
  const { build } = useBuild()
  const [selected, setSelected] = useState<OutputInfo | null>(null)
  // An instructions file that fails to build has no output to count; its template's own text stands in, labelled.
  const [templateTokens, setTemplateTokens] = useState<Record<string, number>>({})
  useEffect(() => {
    for (const o of build?.outputs ?? []) {
      if (o.kind === "instructions" && o.status === "failed" && templateTokens[o.entryId] === undefined) {
        api.file(o.entryId).then((p) => setTemplateTokens((t) => ({ ...t, [o.entryId]: p.render.tokens }))).catch(() => {})
      }
    }
  }, [build])
  if (!build) return <Loading />

  const instructions = build.outputs.filter((o) => o.kind === "instructions")
  const rootInstructions = instructions.filter((o) => !o.output.includes("/"))
  const nested = instructions.filter((o) => o.output.includes("/"))
  const skills = build.outputs.filter((o) => o.kind === "skill").sort((a, b) => (a.skillName ?? "").localeCompare(b.skillName ?? ""))
  const references = build.outputs.filter((o) => o.kind === "reference" || o.kind === "memory" || o.kind === "other")

  const startTokens = rootInstructions.reduce((n, o) => n + o.tokens, 0)
  const menuTokens = skills.reduce((n, o) => n + (o.descriptionTokens ?? 0), 0)
  const demandTokens =
    skills.reduce((n, o) => n + o.tokens - (o.descriptionTokens ?? 0), 0) + references.reduce((n, o) => n + o.tokens, 0)
  const always = startTokens + menuTokens
  const segments = [
    { label: "Instructions", tokens: startTokens, cls: "bg-brand" },
    { label: "Skill menu", tokens: menuTokens, cls: "bg-liquid" },
  ]
  const brokenRoot = rootInstructions.some((o) => o.status === "failed")

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-6 p-8">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BotIcon className="size-6 text-brand" /> What your agent sees
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything sous builds for Claude in this project, sorted by when Claude reads it. Counted with the o200k tokenizer,
            from a fresh build.
          </p>
        </div>

        <Card className="overflow-hidden" data-tour="context-hero">
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Read at the start of every session</div>
                <div className="text-4xl font-bold tracking-tight tabular-nums">
                  {always.toLocaleString()}
                  <span className="ml-1 text-base font-medium text-muted-foreground">tokens</span>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Read only when needed</div>
                <div className="text-2xl font-semibold tracking-tight text-muted-foreground tabular-nums">
                  {demandTokens.toLocaleString()} <span className="text-sm font-medium">tokens</span>
                </div>
              </div>
            </div>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              {segments.map((s) => (
                <div key={s.label} className={cn("h-full", s.cls)} style={{ width: `${(s.tokens / Math.max(always, 1)) * 100}%` }} title={`${s.label}: ${s.tokens.toLocaleString()} tokens`} />
              ))}
            </div>
            <div className="flex gap-5 text-xs text-muted-foreground">
              {segments.map((s) => (
                <span key={s.label} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", s.cls)} /> {s.label}: <b className="text-foreground">{s.tokens.toLocaleString()}</b>
                </span>
              ))}
            </div>
            {brokenRoot && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">
                <CircleAlertIcon className="size-3.5" /> CLAUDE.md can't be built right now, so Claude would read the copy already on disk (or
                none). Open it below to see why.
              </div>
            )}
          </CardContent>
        </Card>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <BookOpenIcon className="size-4 text-brand" /> Instructions
            <span className="font-normal text-muted-foreground">read in full at the start of a session (nested ones when Claude works in that folder)</span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {[...rootInstructions, ...nested].map((o) => (
              <button key={o.output} onClick={() => setSelected(o)} className="rounded-xl border bg-card p-4 text-left transition hover:border-brand/60 hover:shadow-sm">
                <div className="flex items-center gap-2">
                  <FileOutputIcon className="size-4 text-brand" />
                  <span className="font-mono text-sm font-medium">{o.output}</span>
                  <span className="ml-auto">
                    <StatusPill status={o.status} />
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {o.status === "failed"
                    ? `${o.error?.split("\n")[0] ?? "It fails to build."}${templateTokens[o.entryId] !== undefined ? ` Its template alone is ${templateTokens[o.entryId].toLocaleString()} tokens, before includes.` : ""}`
                    : `${o.tokens.toLocaleString()} tokens · built from ${o.sources.length} files`}
                  {o.output.includes("/") && " · only when working in " + o.output.split("/").slice(0, -1).join("/") + "/"}
                </div>
              </button>
            ))}
          </div>
        </section>

        <SkillGuess skills={skills} onOpen={setSelected} />

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <SparklesIcon className="size-4 text-liquid" /> Skill menu
            <span className="font-normal text-muted-foreground">
              {skills.length} skills. Claude reads each name and description up front, and the rest only when it uses the skill.
            </span>
          </h2>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {skills.map((o) => (
              <button key={o.output} onClick={() => setSelected(o)} className="group rounded-xl border bg-card p-3 text-left transition hover:border-liquid/60">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-semibold">/{o.skillName ?? o.output}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    <b className="text-liquid">{o.descriptionTokens ?? 0}</b> + {(o.tokens - (o.descriptionTokens ?? 0)).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{o.description ?? "No description: Claude can't tell when to use this skill."}</p>
                {!o.description && <Badge variant="destructive" className="mt-2">missing description</Badge>}
              </button>
            ))}
          </div>
        </section>

        {references.length > 0 && (
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <LayersIcon className="size-4 text-recipe" /> Reference files
              <span className="font-normal text-muted-foreground">read only when a skill points Claude at them</span>
            </h2>
            <div className="flex flex-wrap gap-2">
              {references.map((o) => (
                <button key={o.output} onClick={() => setSelected(o)} className="rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs hover:border-recipe/60">
                  <span className="font-mono">{o.output.split("/").slice(-3).join("/")}</span>
                  <span className="ml-2 text-muted-foreground tabular-nums">{o.tokens.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <HammerIcon className="size-3.5" /> Built {new Date(build.builtAt).toLocaleTimeString()}. Edits you haven't saved aren't included.
        </p>
      </div>
      <OutputSheet output={selected} onClose={() => setSelected(null)} />
    </ScrollArea>
  )
}
