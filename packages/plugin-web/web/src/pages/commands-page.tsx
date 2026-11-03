// Every command sous has, run from the browser. The list and each form come from the intents
// themselves (their input JSON schemas), so a command a plugin adds tomorrow shows up here with no
// web code for it: the same intents the CLI turns into flags and MCP turns into tools.

import { useEffect, useMemo, useRef, useState } from "react"
import { BanIcon, CheckIcon, LoaderIcon, PlayIcon, SearchIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { RunError, sous, type IntentSummary, type ReportMessage } from "@/lib/socket"
import { cn } from "@/lib/utils"

type Schema = {
  type?: string | string[]
  description?: string
  default?: unknown
  enum?: unknown[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
}

type Run = {
  intent: string
  input: Record<string, unknown>
  reports: ReportMessage[]
  state: "running" | "done" | "failed" | "cancelled"
  result?: unknown
  error?: string
  details?: string[]
  ms?: number
  controller: AbortController
}

const typeOf = (schema: Schema): string => (Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? "string") : (schema.type ?? "string"))

/** One field of a command's form, from its schema. */
function Field({ name, schema, value, onChange, required }: { name: string; schema: Schema; value: unknown; onChange: (v: unknown) => void; required: boolean }) {
  const type = typeOf(schema)
  const label = (
    <div className="flex items-baseline gap-2">
      <code className="font-mono text-xs font-semibold">--{name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}</code>
      {required && <span className="text-[10px] text-warning">required</span>}
      {schema.description && <span className="truncate text-xs text-muted-foreground">{schema.description}</span>}
    </div>
  )
  if (type === "boolean")
    return (
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card px-3 py-2">
        <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <div className="min-w-0">{label}</div>
      </label>
    )
  if (schema.enum)
    return (
      <div className="space-y-1">
        {label}
        <select
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">(default{schema.default !== undefined ? `: ${String(schema.default)}` : ""})</option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </div>
    )
  if (type === "array" || type === "object")
    return (
      <div className="space-y-1">
        {label}
        <Textarea
          className="min-h-16 font-mono text-xs"
          placeholder={type === "array" ? "One value per line" : "JSON"}
          value={value === undefined ? "" : type === "array" ? (value as unknown[]).join("\n") : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            const text = e.target.value
            if (text.trim() === "") return onChange(undefined)
            if (type === "array") return onChange(text.split("\n").filter(Boolean))
            try {
              onChange(JSON.parse(text))
            } catch {
              // Kept as typed until it is valid JSON.
            }
          }}
        />
      </div>
    )
  return (
    <div className="space-y-1">
      {label}
      <Input
        className="h-8 font-mono text-xs"
        type={type === "integer" || type === "number" ? "number" : "text"}
        placeholder={schema.default !== undefined ? `default: ${String(schema.default)}` : ""}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const text = e.target.value
          if (text === "") return onChange(undefined)
          onChange(type === "integer" || type === "number" ? Number(text) : text)
        }}
      />
    </div>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  notice: "text-foreground",
  warning: "text-warning",
  error: "text-destructive",
  critical: "text-destructive",
}

function RunView({ run }: { run: Run }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" })
  }, [run.reports.length, run.state])
  return (
    <div className="space-y-2 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-sm">
        {run.state === "running" && <LoaderIcon className="size-4 animate-spin text-brand" />}
        {run.state === "done" && <CheckIcon className="size-4 text-success" />}
        {run.state === "failed" && <XIcon className="size-4 text-destructive" />}
        {run.state === "cancelled" && <BanIcon className="size-4 text-muted-foreground" />}
        <code className="font-mono font-semibold">{run.intent}</code>
        <span className="truncate font-mono text-xs text-muted-foreground">{JSON.stringify(run.input)}</span>
        {run.ms !== undefined && <span className="ml-auto text-xs text-muted-foreground">{run.ms} ms</span>}
        {run.state === "running" && (
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => run.controller.abort()}>
            <BanIcon /> Cancel
          </Button>
        )}
      </div>
      {run.reports.length > 0 && (
        <div className="max-h-56 overflow-auto rounded-md bg-background p-2 font-mono text-[11.5px] leading-5">
          {run.reports.map((report, i) => (
            <div key={i} className={cn("whitespace-pre-wrap", LEVEL_COLOR[report.level])}>
              {report.level !== "info" && report.level !== "notice" && <span className="mr-1.5 uppercase opacity-70">{report.level}</span>}
              {report.message}
            </div>
          ))}
        </div>
      )}
      {run.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/8 p-2 text-sm">
          <div className="font-medium text-destructive">{run.error}</div>
          {run.details?.map((detail, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              {detail}
            </div>
          ))}
        </div>
      )}
      {run.result !== undefined && (
        <pre className="max-h-96 overflow-auto rounded-md bg-background p-2 font-mono text-[11.5px] leading-5">{JSON.stringify(run.result, null, 2)}</pre>
      )}
      <div ref={end} />
    </div>
  )
}

export function CommandsPage() {
  const [intents, setIntents] = useState<IntentSummary[] | null>(sous.ready?.intents ?? null)
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [input, setInput] = useState<Record<string, unknown>>({})
  const [runs, setRuns] = useState<Run[]>([])

  useEffect(() => {
    sous.whenReady().then((ready) => setIntents(ready.intents))
  }, [])

  const visible = useMemo(
    () =>
      (intents ?? [])
        .filter((i) => !i.internal && !i.background)
        .filter((i) => `${i.intent} ${i.summary ?? ""} ${i.plugin}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => a.intent.localeCompare(b.intent)),
    [intents, q],
  )
  const current = visible.find((i) => i.intent === selected) ?? (intents ?? []).find((i) => i.intent === selected)
  const schema = (current?.input ?? {}) as Schema
  const fields = Object.entries(schema.properties ?? {})

  const update = (run: Run, patch: Partial<Run>) => setRuns((all) => all.map((r) => (r === run ? Object.assign(run, patch) && { ...run } : r)))

  const start = () => {
    if (!current) return
    const run: Run = { intent: current.intent, input, reports: [], state: "running", controller: new AbortController() }
    setRuns((all) => [run, ...all].slice(0, 20))
    const started = performance.now()
    sous
      .run(current.intent, input, {
        signal: run.controller.signal,
        onReport: (report) => setRuns((all) => all.map((r) => (r === run ? Object.assign(run, { reports: [...run.reports, report] }) && { ...run } : r))),
      })
      .then((result) => update(run, { state: "done", result, ms: Math.round(performance.now() - started) }))
      .catch((error: unknown) => {
        const e = error instanceof RunError ? error : new RunError(String(error))
        update(run, { state: e.cancelled ? "cancelled" : "failed", error: e.message, details: e.details, ms: Math.round(performance.now() - started) })
      })
  }

  return (
    <div className="grid h-full grid-cols-[320px_1fr]">
      <div className="flex min-h-0 flex-col border-r">
        <div className="space-y-2 border-b p-3">
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <TerminalSquareIcon className="size-5 text-brand" /> Commands
          </h1>
          <p className="text-xs text-muted-foreground">Every command sous has, from every plugin. The same ones the CLI and agents run.</p>
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter commands…" className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1.5">
            {!intents && <LoaderIcon className="m-4 size-4 animate-spin text-muted-foreground" />}
            {visible.map((i) => (
              <button
                key={i.intent}
                onClick={() => {
                  setSelected(i.intent)
                  setInput({})
                }}
                className={cn("block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-muted", selected === i.intent && "bg-muted")}
              >
                <div className="flex items-center gap-1.5">
                  <code className="font-mono text-[12.5px] font-medium">sous {i.intent.replace(/\./g, " ")}</code>
                  {i.readOnly === true && (
                    <Badge variant="outline" className="h-4 px-1 text-[9px]">
                      reads only
                    </Badge>
                  )}
                </div>
                {i.summary && <div className="truncate text-xs text-muted-foreground">{i.summary}</div>}
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      <ScrollArea className="min-h-0">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          {!current ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              Pick a command on the left. Its form comes from the command's own input schema; questions it asks open as dialogs here.
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex items-baseline gap-2">
                <code className="font-mono text-base font-semibold">sous {current.intent.replace(/\./g, " ")}</code>
                <span className="text-xs text-muted-foreground">from {current.plugin}</span>
              </div>
              {current.summary && <p className="text-sm text-muted-foreground">{current.summary}</p>}
              {current.readOnly !== true && (
                <p className="rounded-md border border-warning/40 bg-warning/8 px-2.5 py-1.5 text-xs">
                  This command may change files or config{current.readOnly === "depends" ? ", depending on its flags" : ""}. It runs for real, as it would in a terminal.
                </p>
              )}
              <div className="grid gap-2.5 md:grid-cols-2">
                {fields.map(([name, field]) => (
                  <Field
                    key={name}
                    name={name}
                    schema={field}
                    required={schema.required?.includes(name) ?? false}
                    value={input[name]}
                    onChange={(value) => setInput((all) => (value === undefined ? Object.fromEntries(Object.entries(all).filter(([k]) => k !== name)) : { ...all, [name]: value }))}
                  />
                ))}
                {fields.length === 0 && <p className="text-xs text-muted-foreground">This command takes no input.</p>}
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={start}>
                  <PlayIcon /> Run
                </Button>
                <code className="truncate font-mono text-xs text-muted-foreground">
                  sous {current.intent.replace(/\./g, " ")}{" "}
                  {Object.entries(input)
                    .map(([k, v]) => (v === true ? `--${k}` : v === false ? `--no-${k}` : `--${k} ${Array.isArray(v) ? v.join(",") : JSON.stringify(v)}`))
                    .join(" ")}
                </code>
              </div>
            </div>
          )}
          {runs.map((run, i) => (
            <RunView key={runs.length - i} run={run} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
