// Variables page. REAL: the same facts `sous vars list` prints (who asks for a
// variable, its value, which environment variable and file answered it), plus
// which source files use each variable.

import { Fragment, useEffect, useState } from "react"
import { ChevronRightIcon, FileCode2Icon, KeyRoundIcon, LoaderIcon, PackageIcon, SearchIcon, VariableIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, type VarFact } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

export function VariablesPage() {
  const [facts, setFacts] = useState<VarFact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [show, setShow] = useState<"used" | "all">("used")
  const [openRow, setOpenRow] = useState<string | null>(null)
  const files = useStore((s) => s.workspace?.files ?? [])
  const open = useStore((s) => s.open)

  useEffect(() => {
    api.variables().then(setFacts).catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="p-8 text-sm text-destructive">{error}</p>
  if (!facts)
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <LoaderIcon className="size-5 animate-spin" />
      </div>
    )

  const rows = facts
    .filter((f) => (show === "all" ? true : f.usedIn.length > 0))
    .filter((f) => `${f.name} ${f.value ?? ""} ${f.recipe ?? ""} ${f.description ?? ""}`.toLowerCase().includes(q.toLowerCase()))
  const unanswered = facts.filter((f) => f.recipe && f.value === null)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-5 p-8">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <VariableIcon className="size-6 text-liquid" /> Variables
          </h1>
          <p className="text-sm text-muted-foreground">
            Every variable your templates can use: its value, where that value comes from, and which files use it. The same
            facts as <code className="rounded bg-muted px-1">sous vars list</code>. Secrets show as ••••••.
          </p>
        </div>
        {unanswered.length > 0 && (
          <div className="rounded-xl border border-warning/40 bg-warning/8 p-3 text-sm">
            <b className="text-warning">{unanswered.length} unanswered:</b>{" "}
            {unanswered.map((f) => (
              <code key={f.name} className="mr-1.5 font-mono text-xs">
                {f.name}
              </code>
            ))}
            <span className="text-muted-foreground">These render as empty text. Answer them with sous vars ask.</span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div className="relative w-72">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, value or recipe…" className="pl-8" />
          </div>
          <ToggleGroup value={[show]} onValueChange={(v) => v[0] && setShow(v[0] as typeof show)} variant="outline" size="sm">
            <ToggleGroupItem value="used" className="px-2.5 text-xs">
              Used in templates ({facts.filter((f) => f.usedIn.length).length})
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="px-2.5 text-xs">
              All ({facts.length})
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Card className="py-0">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%]">Variable</TableHead>
                <TableHead className="w-[30%]">Value</TableHead>
                <TableHead className="w-[28%]">Comes from</TableHead>
                <TableHead className="w-[16%] text-right">Used in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <Fragment key={f.name}>
                  <TableRow className="cursor-pointer" onClick={() => setOpenRow(openRow === f.name ? null : f.name)}>
                    <TableCell className="truncate font-mono text-xs text-liquid">
                      <ChevronRightIcon className={cn("mr-1 inline size-3 text-muted-foreground transition-transform", openRow === f.name && "rotate-90")} />
                      {f.secret && <KeyRoundIcon className="mr-1 inline size-3 text-warning" />}
                      {f.name}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={f.value ?? ""}>
                      {f.value === null ? <span className="text-warning italic">unanswered</span> : f.value === "" ? <i className="text-muted-foreground">(empty)</i> : f.value}
                    </TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground" title={f.answeredBy}>
                      {f.answeredBy ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {f.usedIn.length ? `${f.usedIn.length} file${f.usedIn.length === 1 ? "" : "s"}` : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                  {openRow === f.name && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={4} className="whitespace-normal">
                        <div className="grid gap-4 py-2 md:grid-cols-2">
                          <div className="space-y-2 text-xs">
                            {f.description && <p className="text-sm">{f.description}</p>}
                            <div className="flex flex-wrap gap-1.5">
                              {f.recipe && (
                                <Badge variant="secondary" className="gap-1">
                                  <PackageIcon className="size-3 text-recipe" /> asked for by {f.recipe}
                                </Badge>
                              )}
                              {f.type && <Badge variant="outline">{f.type}</Badge>}
                              {f.secret && <Badge variant="outline" className="border-warning/50 text-warning">secret</Badge>}
                            </div>
                            {f.envName && (
                              <p className="text-muted-foreground">
                                Answered by <code className="rounded bg-muted px-1 font-mono text-foreground">{f.envName}</code> ({f.answeredBy}).
                              </p>
                            )}
                            <p className="text-muted-foreground">
                              Use it in a template as <code className="rounded bg-liquid-soft px-1 font-mono text-liquid">{`{{ ${f.name} }}`}</code>.
                            </p>
                          </div>
                          <div className="space-y-1.5">
                            <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                              {f.usedIn.length ? "Used in" : "Not used by any template"}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {f.usedIn.map((id) => {
                                const file = files.find((x) => x.id === id)
                                return (
                                  <button
                                    key={id}
                                    onClick={() => open(id)}
                                    className="flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-left font-mono text-[11px] hover:border-brand hover:text-brand"
                                  >
                                    <FileCode2Icon className="size-3" /> {file?.display ?? id}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </ScrollArea>
  )
}
