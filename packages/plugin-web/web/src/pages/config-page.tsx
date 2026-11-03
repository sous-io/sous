// Config page. REAL: the config layers sous merges, in order, what each one
// changes, and which layer gave each setting its final value (the trace behind
// `sous config get --layers`). Read-only.

import { useEffect, useMemo, useState } from "react"
import { ArrowDownIcon, FileCogIcon, LayersIcon, LoaderIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type ConfigReport } from "@/lib/api"
import { cn } from "@/lib/utils"

const KIND_LABEL: Record<string, string> = { primary: "main config", "conf.d": "drop-in layer", recipe: "recipe layer", other: "layer" }

export function ConfigPage() {
  const [report, setReport] = useState<ConfigReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [q, setQ] = useState("")
  useEffect(() => {
    api.config().then(setReport).catch((e) => setError(e.message))
  }, [])
  const settings = useMemo(
    () => (report?.settings ?? []).filter((s) => `${s.key} ${s.value}`.toLowerCase().includes(q.toLowerCase())),
    [report, q],
  )
  if (error) return <p className="p-8 text-sm text-destructive">{error}</p>
  if (!report)
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <LoaderIcon className="size-5 animate-spin" />
      </div>
    )
  const layer = report.layers[selected]

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-6 p-8">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <SlidersHorizontalIcon className="size-6 text-brand" /> Config
          </h1>
          <p className="text-sm text-muted-foreground">
            The files sous merges into this project's config, in order. A later layer wins. Search below for any setting to see which file
            set it.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <div className="space-y-1">
            {report.layers.map((l, i) => (
              <div key={l.path}>
                {i > 0 && <ArrowDownIcon className="mx-auto my-0.5 size-3.5 text-muted-foreground/60" />}
                <button
                  onClick={() => setSelected(i)}
                  className={cn(
                    "w-full rounded-xl border bg-card p-3 text-left transition hover:border-brand/50",
                    selected === i && "border-brand/60 ring-2 ring-brand/20",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <FileCogIcon className="size-4 shrink-0 text-brand" />
                    <span className="truncate font-mono text-xs font-medium">{l.display}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="secondary" className="h-4 text-[10px] font-normal">
                      {KIND_LABEL[l.kind]}
                    </Badge>
                    {l.changes.length ? `sets ${l.changes.length}` : "changes nothing"}
                  </div>
                </button>
              </div>
            ))}
          </div>

          <Card className="min-w-0 gap-0 py-0">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <LayersIcon className="size-4 text-brand" />
              <span className="font-mono text-sm">{layer.display}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {layer.changes.length} setting{layer.changes.length === 1 ? "" : "s"}
              </span>
            </div>
            {layer.changes.length > 0 ? (
              <div className="divide-y">
                {layer.changes.map((c) => (
                  <div key={c.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-4 py-2 text-xs">
                    <span className="truncate font-mono text-liquid" title={c.key}>
                      {c.key}
                    </span>
                    <span className="min-w-0 truncate font-mono" title={c.value}>
                      {c.was !== undefined && <span className="mr-2 text-muted-foreground line-through">{c.was}</span>}
                      {c.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                This layer doesn't change anything that the layers before it hadn't already set.
              </p>
            )}
            {layer.text && (
              <details className="border-t">
                <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground hover:text-foreground">Show the file</summary>
                <pre className="max-h-96 overflow-auto bg-muted/40 px-4 py-3 font-mono text-[11px] leading-relaxed">{layer.text}</pre>
              </details>
            )}
          </Card>
        </div>

        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Where is a setting set?</h2>
            <div className="relative w-80">
              <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. compilation, tools.claude, _vars" className="pl-8" />
            </div>
          </div>
          <Card className="py-0">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[32%]">Setting</TableHead>
                  <TableHead className="w-[43%]">Final value</TableHead>
                  <TableHead className="w-[25%]">Set by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="truncate font-mono text-xs text-liquid" title={s.key}>
                      {s.key}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={s.value}>
                      {s.value}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs text-muted-foreground">{s.layer}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      </div>
    </ScrollArea>
  )
}
