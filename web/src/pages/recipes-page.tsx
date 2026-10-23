// Recipes page. REAL: read from the recipe store (~/.sous/cache) and each
// recipe's sous.recipe.yaml. Subscribing and updating are simulated.

import { useEffect, useState } from "react"
import {
  ArrowUpCircleIcon,
  BookOpenIcon,
  BrainIcon,
  FolderSearchIcon,
  GitPullRequestArrowIcon,
  LinkIcon,
  LoaderIcon,
  PackageIcon,
  PackagePlusIcon,
  SearchIcon,
  SparklesIcon,
  VariableIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, type CatalogRecipe } from "@/lib/api"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const KIND_ICON: Record<string, typeof SparklesIcon> = { skills: SparklesIcon, memories: BrainIcon, prompts: BookOpenIcon }

function RecipeCard({ r }: { r: CatalogRecipe }) {
  const setPage = useStore((s) => s.setPage)
  const setFilter = useStore((s) => s.setExplorerFilter)
  const openContribute = useStore((s) => s.openContribute)
  const update = r.using && r.using !== r.latest ? r.latest : null

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card p-4 transition hover:shadow-md",
        update && "border-recipe/50",
        !r.using && "border-dashed bg-card/60",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", r.using ? "bg-recipe/15 text-recipe" : "bg-muted text-muted-foreground")}>
          <PackageIcon className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">
              <span className="text-muted-foreground">{r.namespace}/</span>
              {r.name}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{r.using ?? r.latest}</span>
            <span>·</span>
            <span>{r.repo}</span>
            {update && (
              <Badge className="h-5 gap-1 bg-recipe/15 text-recipe">
                <ArrowUpCircleIcon className="size-3" /> {update} downloaded
              </Badge>
            )}
          </div>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-[13px] leading-5 text-muted-foreground">{r.description ?? "No description."}</p>
      <div className="flex-1" />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {r.kinds.map((k) => {
          const Icon = KIND_ICON[k] ?? BookOpenIcon
          return (
            <Badge key={k} variant="secondary" className="gap-1 font-normal">
              <Icon className="size-3" /> {k}
            </Badge>
          )
        })}
        <Badge variant="outline" className="font-normal">
          {r.files} file{r.files === 1 ? "" : "s"}
        </Badge>
        {r.variables.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="outline" className="cursor-help gap-1 font-normal">
                  <VariableIcon className="size-3" /> {r.variables.length} question{r.variables.length === 1 ? "" : "s"}
                </Badge>
              }
            />
            <TooltipContent className="max-w-xs">
              {r.variables.map((v) => v.name + (v.secret ? " (secret)" : "")).join(", ")}
            </TooltipContent>
          </Tooltip>
        )}
        {r.depends.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="outline" className="cursor-help gap-1 font-normal">
                  <LinkIcon className="size-3" /> uses {r.depends.length} recipe{r.depends.length === 1 ? "" : "s"}
                </Badge>
              }
            />
            <TooltipContent>{r.depends.join(", ")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t pt-3">
        {r.using ? (
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setFilter(`${r.namespace}/${r.name}/`)
                setPage("editor")
              }}
            >
              <FolderSearchIcon /> Browse files
            </Button>
            {update && (
              <Button size="xs" onClick={() => toast.success(`Would run: sous subscription update ${r.repo.split("/")[1]} (simulated)`)}>
                <ArrowUpCircleIcon /> Update to {update}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => {
                      const unsent = Object.entries(useStore.getState().docs).some(([, d]) => d.current !== d.original && d.proposedContent !== d.current)
                      if (unsent) return openContribute()
                      // Nothing edited yet: start where an edit happens, in the recipe's files.
                      setFilter(`${r.namespace}/${r.name}/`)
                      setPage("editor")
                      toast(`Edit any file of ${r.namespace}/${r.name}, then press Send in the header to propose it.`)
                    }}
                  >
                    <GitPullRequestArrowIcon /> {r.acceptsProposals ? "Contribute" : "Contribute (to sous)"}
                  </Button>
                }
              />
              <TooltipContent className="max-w-xs">
                {r.acceptsProposals ? `Edits go to ${r.repo} as a pull request.` : (r.proposalsInstead ?? "This recipe doesn't take proposals here.")}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Button size="xs" variant="outline" onClick={() => toast(`Would run: sous subscription add ${r.namespace}/${r.name} (simulated)`)}>
            <PackagePlusIcon /> Add to this project
          </Button>
        )}
      </div>
    </div>
  )
}

export function RecipesPage() {
  const [recipes, setRecipes] = useState<CatalogRecipe[] | null>(null)
  const [q, setQ] = useState("")
  useEffect(() => {
    api.recipes().then(setRecipes)
  }, [])
  if (!recipes)
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <LoaderIcon className="size-5 animate-spin" />
      </div>
    )
  const match = (r: CatalogRecipe) => `${r.namespace}/${r.name} ${r.description ?? ""}`.toLowerCase().includes(q.toLowerCase())
  const used = recipes.filter((r) => r.using && match(r))
  const available = recipes.filter((r) => !r.using && match(r))
  const updates = recipes.filter((r) => r.using && r.using !== r.latest)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-6 p-8">
        <div className="flex items-end gap-4">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <PackageIcon className="size-6 text-recipe" /> Recipes
            </h1>
            <p className="text-sm text-muted-foreground">
              The recipes this project uses, and the others already downloaded to this machine. Read from each recipe's{" "}
              <code className="rounded bg-muted px-1">sous.recipe.yaml</code>.
            </p>
          </div>
          <div className="relative ml-auto w-72">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes…" className="pl-8" />
          </div>
        </div>
        {updates.length > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-recipe/40 bg-recipe/8 px-4 py-3 text-sm">
            <ArrowUpCircleIcon className="size-4 text-recipe" />
            <span>
              <b>
                {updates.length} update{updates.length === 1 ? "" : "s"}
              </b>{" "}
              downloaded but not applied yet: {updates.map((r) => `${r.namespace}/${r.name} ${r.using} → ${r.latest}`).join(", ")}.
            </span>
          </div>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">
            Used by this project <span className="font-normal text-muted-foreground">({used.length})</span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {used.map((r) => (
              <RecipeCard key={r.key} r={r} />
            ))}
          </div>
        </section>
        {available.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">
              Downloaded, not used here <span className="font-normal text-muted-foreground">({available.length})</span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {available.map((r) => (
                <RecipeCard key={r.key} r={r} />
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
