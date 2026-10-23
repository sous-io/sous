// Variables a recipe file reads but its recipe doesn't declare. The file works
// in this project only because something else sets them; every other project
// that uses the recipe gets empty text. REAL: LiquidJS static analysis of the
// template, against the recipe's sous.recipe.yaml and those of its dependencies.

import { useMemo, useState } from "react"
import { CopyIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { CatalogRecipe, WorkspaceFile } from "@/lib/api"
import { useStore } from "@/lib/store"

type Finding = { name: string; declaredBy: string | null }

function declaredFor(recipe: CatalogRecipe, catalog: CatalogRecipe[], seen = new Set<string>()): Set<string> {
  const names = new Set(recipe.variables.map((v) => v.name))
  seen.add(recipe.key)
  for (const dep of recipe.depends) {
    const ref = dep.split("@")[0]
    const found = catalog.find((r) => `${r.namespace}/${r.name}` === ref)
    if (found && !seen.has(found.key)) for (const n of declaredFor(found, catalog, seen)) names.add(n)
  }
  return names
}

export function useUndeclared(file: WorkspaceFile): Finding[] {
  const uses = useStore((s) => s.docs[file.id]?.render.uses)
  const catalog = useStore((s) => s.catalog)
  const builtins = useStore((s) => s.builtins)
  return useMemo(() => {
    const o = file.origin
    if (o.kind !== "recipe" || !uses || !catalog) return []
    const recipe = catalog.find((r) => r.namespace === o.namespace && r.name === o.recipe && r.repo === `${o.owner}/${o.repo}`)
    if (!recipe) return []
    const declared = declaredFor(recipe, catalog)
    return uses
      .filter((name) => !declared.has(name) && !builtins.includes(name))
      .map((name) => {
        const other = catalog.find((r) => r.variables.some((v) => v.name === name))
        return { name, declaredBy: other ? `${other.namespace}/${other.name}` : null }
      })
  }, [file, uses, catalog, builtins])
}

export function UndeclaredBanner({ file }: { file: WorkspaceFile }) {
  const findings = useUndeclared(file)
  const [hidden, setHidden] = useState(false)
  if (findings.length === 0 || hidden || file.origin.kind !== "recipe") return null
  const recipe = `${file.origin.namespace}/${file.origin.recipe}`
  const yaml = `variables:\n${findings
    .map((f) => `  - name: ${f.name}\n    type: string\n    description: >-\n      TODO: what this variable is for.`)
    .join("\n")}`

  return (
    <div className="flex items-center gap-2 border-b bg-warning/8 px-4 py-1.5 text-xs">
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 truncate">
        Reads{" "}
        {findings.map((f, i) => (
          <span key={f.name}>
            {i > 0 && ", "}
            <code className="rounded bg-liquid-soft px-1 text-liquid">{f.name}</code>
          </span>
        ))}
        , which <b>{recipe}</b> doesn't declare.{" "}
        <span className="text-muted-foreground">It works here; other projects using this recipe may get empty text.</span>
      </span>
      <Popover>
        <PopoverTrigger render={<Button size="xs" variant="outline" className="ml-auto shrink-0 bg-background/60" />}>Details</PopoverTrigger>
        <PopoverContent className="w-96 space-y-3 text-xs" align="end">
          {findings.map((f) => (
            <p key={f.name}>
              <code className="rounded bg-liquid-soft px-1 text-liquid">{f.name}</code>{" "}
              {f.declaredBy
                ? `is declared by ${f.declaredBy}, which ${recipe} doesn't depend on. Add it to depends, or declare it here.`
                : "isn't declared by any recipe in your store. It's probably set in this project's config."}
            </p>
          ))}
          <div>
            <div className="mb-1 font-medium">To declare it in this recipe's sous.recipe.yaml:</div>
            <pre className="rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{yaml}</pre>
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              navigator.clipboard?.writeText(yaml).catch(() => {})
              toast.success("Copied the YAML")
            }}
          >
            <CopyIcon /> Copy YAML
          </Button>
        </PopoverContent>
      </Popover>
      <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setHidden(true)}>
        Hide
      </Button>
    </div>
  )
}
