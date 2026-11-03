// "Share as a recipe": turn one of this project's files into a new recipe and
// propose it to a recipe repository. MOCK for the sending; the generated
// manifest, the generic version of the file and the project change are real
// text computed from the file and this project's variables.

import { useMemo, useRef, useState } from "react"
import { nextPrNumber, useJustSent } from "@/components/contribute/model"
import { BrainIcon, CheckIcon, LoaderIcon, PackagePlusIcon, SparklesIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { WorkspaceFile } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { contributionBranch, type Proposal } from "@/mock/data"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.tpl\.md$|\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export function ShareRecipeButton({ file }: { file: WorkspaceFile }) {
  const [open, setOpen] = useState(false)
  if (file.origin.kind !== "project") return null
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Turn this file into a recipe other projects can use">
        <PackagePlusIcon /> <span className="max-[1400px]:hidden">Share as recipe</span>
      </Button>
      {open && <ShareRecipeDialog file={file} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareRecipeDialog({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  const doc = useStore((s) => s.docs[file.id])
  const catalog = useStore((s) => s.catalog) ?? []
  const addProposal = useStore((s) => s.addProposal)
  const setPage = useStore((s) => s.setPage)
  const repos = [...new Set(catalog.map((r) => r.repo))]
  const namespaces = [...new Set(catalog.map((r) => r.namespace))].sort()
  const base = file.display.split("/").pop() ?? "file.md"
  const isSkill = /SKILL\.tpl\.md$/.test(base)

  const [repo, setRepo] = useState(repos[0] ?? "sous-io/sous-recipes")
  const [namespace, setNamespace] = useState(namespaces.includes("workflow") ? "workflow" : (namespaces[0] ?? "workflow"))
  const [name, setName] = useState(slug(isSkill ? (file.display.split("/").slice(-2)[0] ?? base) : base))
  const [kind, setKind] = useState<"memories" | "skills">(isSkill ? "skills" : "memories")
  // Written by you: it's what other people read when they decide whether to subscribe.
  const [description, setDescription] = useState("")
  const [phase, setPhase] = useState<"edit" | "sending" | "done">("edit")
  const sentId = useRef<string | null>(null)
  const taken = catalog.some((r) => r.namespace === namespace && r.name === name)
  const [step, setStep] = useState(0)

  // This project's own values in the file: each becomes a variable the new recipe asks for.
  const found = useMemo(() => {
    const vars = doc?.vars ?? {}
    const text = doc?.current ?? ""
    return Object.entries(vars)
      // Only values that look specific to this project: paths, names, IDs. Plain words like "always" are left alone.
      .filter(([k, v]) => v.length >= 5 && v !== "••••••" && !k.startsWith("sous") && !/^[a-z-]+$/.test(v) && text.includes(v))
      // A value that only appears as part of a package name (@owner/name) isn't this project's own.
      .filter(([, v]) => text.split(v).slice(0, -1).some((before) => !before.endsWith("@")))
      .filter(([, v], i, all) => all.findIndex(([, w]) => w === v) === i)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
  }, [doc])
  const [replace, setReplace] = useState<Record<string, boolean>>(() => Object.fromEntries(found.map(([k]) => [k, true])))

  const generic = useMemo(() => {
    let text = doc?.current ?? ""
    // Replace the value everywhere except where it's part of a package name (@owner/name).
    for (const [k, v] of found) if (replace[k]) text = text.replace(new RegExp(`(?<!@)${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), `{{ ${k} }}`)
    return text
  }, [doc, found, replace])
  const localIncludes = (doc?.current ?? "").split("\n").filter((l) => /^@(\$\{sousDir\}|\$\{projectRoot\}|#project|\.\.?\/)/.test(l.trim()))
  const fileName = kind === "skills" ? `skills/${name}/SKILL.tpl.md` : `memories/${name}.tpl.md`
  const manifest = [
    `# ${namespace}/${name}`,
    "formatVersion: 1",
    "",
    `namespace: ${namespace}`,
    `name: ${name}`,
    "version: 0.1.0",
    "",
    "description: >-",
    ...((description || "TODO: what this recipe teaches an agent.").match(/.{1,74}(\s|$)/g) ?? []).map((l) => `  ${l.trim()}`),
    "",
    "contents:",
    `  - kind: ${kind}`,
    "    include:",
    `      - ${kind === "skills" ? "skills/*/SKILL.tpl.md" : "memories/*.md"}`,
    ...(found.some(([k]) => replace[k])
      ? [
          "",
          "variables:",
          ...found
            .filter(([k]) => replace[k])
            .flatMap(([k, v]) => [`  - name: ${k}`, "    type: string", "    description: >-", `      TODO: what ${k} is for.`, `    example: ${JSON.stringify(v)}`]),
        ]
      : []),
  ].join("\n")
  const projectChange = `@~${namespace}/${name}/${fileName.replace(/\.tpl\.md$/, ".md")}`

  const steps = [
    `Linking ${repo} on a new branch`,
    `Writing recipes/${namespace}/${name}/sous.recipe.yaml`,
    `Writing recipes/${namespace}/${name}/${fileName}`,
    "Checking it with sous repo release --check",
    "Committing and pushing",
    `Opening a pull request on ${repo}`,
  ]

  const send = () => {
    setPhase("sending")
    let i = 0
    const t = window.setInterval(() => {
      i++
      setStep(i)
      if (i >= steps.length) {
        window.clearInterval(t)
        const proposal: Proposal = {
          id: `share-${Date.now()}`,
          repo: `github.com/${repo}`,
          number: nextPrNumber(`github.com/${repo}`, useStore.getState().proposals.filter((x) => x.repo === `github.com/${repo}`).map((x) => x.number)),
          title: `${namespace}/${name}: new recipe`,
          branch: contributionBranch(),
          recipes: [{ name: `${namespace}/${name}`, from: "new", to: "0.1.0" }],
          files: 2,
          stage: "opened",
          openedAt: "just now",
          draft: false,
        }
        sentId.current = proposal.id
        addProposal(proposal, [])
        setPhase("done")
      }
    }, 450)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(820px,92vh)] max-w-5xl flex-col gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <PackagePlusIcon className="size-4 text-brand" /> Share {base} as a recipe
          </DialogTitle>
          <DialogDescription>
            Other projects subscribe to it and get it in their builds. Your own values become variables they answer. Sending is simulated.
          </DialogDescription>
        </DialogHeader>
        {phase === "edit" ? (
          <div className="grid min-h-0 flex-1 md:grid-cols-[360px_1fr]">
            <ScrollArea className="min-h-0 border-r">
              <div className="space-y-5 p-5">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Repository</Label>
                  <ToggleGroup value={[repo]} onValueChange={(v) => v[0] && setRepo(v[0] as string)} variant="outline" size="sm" className="flex-wrap">
                    {(repos.length ? repos : ["sous-io/sous-recipes"]).map((r) => (
                      <ToggleGroupItem key={r} value={r} className="px-2.5 text-xs">
                        {r}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Namespace</Label>
                    <Input value={namespace} onChange={(e) => setNamespace(slug(e.target.value) || e.target.value)} list="sous-namespaces" />
                    <datalist id="sous-namespaces">
                      {namespaces.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Recipe name</Label>
                    <Input value={name} onChange={(e) => setName(slug(e.target.value))} />
                  </div>
                </div>
                {taken && (
                  <p className="rounded-lg border border-warning/40 bg-warning/8 p-2 text-xs text-warning">
                    {namespace}/{name} already exists in your recipe store. Pick another name, or send your change to that recipe instead.
                  </p>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">It's a…</Label>
                  <ToggleGroup value={[kind]} onValueChange={(v) => v[0] && setKind(v[0] as typeof kind)} variant="outline" size="sm" className="flex-wrap">
                    <ToggleGroupItem value="memories" className="px-2.5 text-xs">
                      <BrainIcon /> Memory (always loaded)
                    </ToggleGroupItem>
                    <ToggleGroupItem value="skills" className="px-2.5 text-xs">
                      <SparklesIcon /> Skill (loaded when needed)
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                    className="text-xs"
                    placeholder="One or two sentences: what this teaches an agent, and when a project would want it."
                  />
                </div>
                {localIncludes.length > 0 && (
                  <p className="rounded-lg border border-warning/40 bg-warning/8 p-2 text-xs text-warning">
                    This file includes {localIncludes.length} file{localIncludes.length === 1 ? "" : "s"} from your own project ({localIncludes[0].trim()}
                    {localIncludes.length > 1 ? ", …" : ""}). Projects that subscribe won't have {localIncludes.length === 1 ? "it" : "them"}: share those
                    files too, or inline them.
                  </p>
                )}
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <WandSparklesIcon className="size-3.5 text-liquid" /> Make it generic
                  </Label>
                  {found.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No values from this project appear in the file. It's already generic.</p>
                  ) : (
                    found.map(([k, v]) => (
                      <label key={k} className="flex cursor-pointer items-start gap-2 rounded-lg border bg-card p-2 text-xs">
                        <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={!!replace[k]} onChange={(e) => setReplace({ ...replace, [k]: e.target.checked })} />
                        <span className="min-w-0">
                          Replace <code className="rounded bg-muted px-1">{v.length > 40 ? v.slice(0, 40) + "…" : v}</code> with{" "}
                          <code className="rounded bg-liquid-soft px-1 text-liquid">{`{{ ${k} }}`}</code>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </ScrollArea>
            <div className="flex min-h-0 flex-col">
              <Tabs defaultValue="file" className="min-h-0 flex-1 gap-0">
                <div className="border-b px-4 py-2">
                  <TabsList variant="line">
                    <TabsTrigger value="file">{fileName}</TabsTrigger>
                    <TabsTrigger value="manifest">sous.recipe.yaml</TabsTrigger>
                    <TabsTrigger value="project">Your project</TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="file" className="min-h-0">
                  <ScrollArea className="h-full">
                    <pre className="p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                      {generic.split(/(\{\{ [\w]+ \}\})/).map((part, i) =>
                        /^\{\{ [\w]+ \}\}$/.test(part) && found.some(([k]) => part === `{{ ${k} }}`) ? (
                          <span key={i} className="rounded bg-liquid-soft px-0.5 text-liquid">
                            {part}
                          </span>
                        ) : (
                          <span key={i}>{part}</span>
                        ),
                      )}
                    </pre>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="manifest" className="min-h-0">
                  <ScrollArea className="h-full">
                    <pre className="p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{manifest}</pre>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="project" className="min-h-0 space-y-3 p-4 text-sm">
                  <p className="text-muted-foreground">Once the recipe is released, sous changes this project to use it:</p>
                  <ul className="space-y-2 text-xs">
                    <li className="rounded-lg border bg-card p-3">
                      <b>sous.config.js</b> subscribes to <code className="rounded bg-muted px-1">{`${namespace}/${name}`}</code>.
                    </li>
                    <li className="rounded-lg border bg-card p-3">
                      <b>{file.display}</b> is replaced by an include of the recipe's copy:
                      <pre className="mt-2 rounded bg-muted px-2 py-1 font-mono">{projectChange}</pre>
                    </li>
                    <li className="rounded-lg border bg-card p-3">
                      The values above are kept as this project's answers, so your build doesn't change.
                    </li>
                  </ul>
                </TabsContent>
              </Tabs>
              <div className="flex items-center gap-3 border-t px-5 py-3">
                <span className="text-xs text-muted-foreground">
                  Proposes <b className="text-foreground">{`${namespace}/${name}`}</b> 0.1.0 to {repo}.
                </span>
                <Button className="ml-auto" onClick={send} disabled={!name || !namespace || taken || description.trim().length < 10} title={description.trim().length < 10 ? "Add a description first" : undefined}>
                  <PackagePlusIcon /> Propose new recipe
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <div className="w-full max-w-md space-y-4">
              <ol className="space-y-2">
                {steps.map((s, i) => (
                  <li key={s} className={cn("flex items-center gap-2 text-sm", i > step && "text-muted-foreground")}>
                    {i < step ? (
                      <CheckIcon className="size-4 text-success" />
                    ) : i === step && phase === "sending" ? (
                      <LoaderIcon className="size-4 animate-spin text-brand" />
                    ) : (
                      <span className="size-4" />
                    )}
                    {s}
                  </li>
                ))}
              </ol>
              {phase === "done" && (
                <div className="space-y-3 rounded-xl border border-success/40 bg-success/8 p-4">
                  <div className="flex items-center gap-2 font-medium">
                    <PackagePlusIcon className="size-4 text-success" /> {`${namespace}/${name}`} proposed
                    <Badge variant="outline" className="text-[10px]">
                      simulated
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When a maintainer merges and releases it, this project switches to the recipe, and anyone can subscribe to it.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        onClose()
                        useJustSent.getState().set(sentId.current)
                        setPage("proposals")
                      }}
                    >
                      Track it
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard?.writeText(manifest).catch(() => {})
                        toast.success("Copied the manifest")
                      }}
                    >
                      Copy the manifest
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
