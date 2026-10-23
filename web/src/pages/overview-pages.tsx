// Variables, Recipes and Build pages. The lists come from the real project;
// the "where it was set", update badges, and build actions are MOCK.

import { useEffect, useMemo, useState } from "react"
import { CheckCircle2Icon, DownloadIcon, GitPullRequestArrowIcon, HammerIcon, LoaderIcon, PackageIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { MOCK_UPDATES } from "@/mock/data"

function PageHeader({ title, mock, children }: { title: string; mock?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        {title} {mock && <Badge variant="outline">{mock}</Badge>}
      </h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function layerOf(name: string): string {
  if (name.startsWith("sous") || name === "projectRoot") return "built in"
  if (/^github|ticket|issue/.test(name)) return "conf.d/github.yaml"
  if (/PullRequest|Branches|Publish|Issues|Messages/.test(name)) return "recipe answer"
  return "sous.config.js"
}

export function VariablesPage() {
  const [vars, setVars] = useState<Record<string, string> | null>(null)
  const [q, setQ] = useState("")
  useEffect(() => {
    api.file("sample").then((p) => setVars(p.vars))
  }, [])
  const rows = Object.entries(vars ?? {}).filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-4 p-8">
        <PageHeader title="Variables" mock="'Set in' is mock">
          Every variable this project's templates can use, with the value they get. Secrets show as ••••••.
        </PageHeader>
        <div className="relative w-72">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="pl-8" />
        </div>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-44">Set in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="font-mono text-xs text-[var(--cm-liquid)]">{k}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={v}>
                    {v}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal">
                      {layerOf(k)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </ScrollArea>
  )
}

export function RecipesPage() {
  const files = useStore((s) => s.workspace?.files ?? [])
  const openContribute = useStore((s) => s.openContribute)
  const recipes = useMemo(() => {
    const map = new Map<string, { name: string; version: string; repo: string; files: number }>()
    for (const f of files) {
      if (f.origin.kind !== "recipe") continue
      const name = `${f.origin.namespace}/${f.origin.recipe}`
      const entry = map.get(name) ?? { name, version: f.origin.version, repo: `${f.origin.owner}/${f.origin.repo}`, files: 0 }
      entry.files++
      map.set(name, entry)
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [files])

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-4 p-8">
        <PageHeader title="Recipes" mock="updates are mock">
          The recipes this project subscribes to. Update one, or send a change back to it.
        </PageHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {recipes.map((r) => {
            const update = MOCK_UPDATES[r.name]
            return (
              <Card key={r.name} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <PackageIcon className="size-4 text-sky-500" /> {r.name}
                    <span className="font-mono text-xs font-normal text-muted-foreground">{r.version}</span>
                    {update && <Badge className="ml-auto bg-sky-500/15 text-sky-600 dark:text-sky-400">{update} available</Badge>}
                  </CardTitle>
                  <CardDescription>
                    {r.repo} · {r.files} template{r.files === 1 ? "" : "s"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex gap-2">
                  {update && (
                    <Button size="xs" onClick={() => toast.success(`${r.name} updated to ${update} (mock)`)}>
                      <DownloadIcon /> Update
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => openContribute()}>
                    <GitPullRequestArrowIcon /> Contribute
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </ScrollArea>
  )
}

export function BuildPage() {
  const files = useStore((s) => s.workspace?.files ?? [])
  const outputs = files.flatMap((f) => f.outputs.map((o) => ({ out: o, from: f.display })))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)

  const rebuild = () => {
    setRunning(true)
    setProgress(0)
    let p = 0
    const t = window.setInterval(() => {
      p += 7
      setProgress(Math.min(p, 100))
      if (p >= 100) {
        window.clearInterval(t)
        setRunning(false)
        toast.success(`Built ${outputs.length} files (mock)`)
      }
    }, 60)
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-4 p-8">
        <div className="flex items-end gap-4">
          <PageHeader title="Build" mock="mock">
            What <code>sous build</code> writes, and whether each file is up to date.
          </PageHeader>
          <Button className="ml-auto" onClick={rebuild} disabled={running}>
            {running ? <LoaderIcon className="animate-spin" /> : <HammerIcon />} Rebuild
          </Button>
        </div>
        {running && <Progress value={progress} />}
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Output</TableHead>
                <TableHead>Built from</TableHead>
                <TableHead className="w-32">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outputs.map((o) => (
                <TableRow key={o.out}>
                  <TableCell className="font-mono text-xs">{o.out}</TableCell>
                  <TableCell className="max-w-sm truncate font-mono text-xs text-muted-foreground">{o.from}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2Icon className="size-3.5" /> up to date
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </ScrollArea>
  )
}
