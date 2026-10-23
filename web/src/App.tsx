import { useEffect } from "react"
import {
  BotIcon,
  BoxesIcon,
  ChefHatIcon,
  FileCode2Icon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
  HammerIcon,
  LoaderIcon,
  MoonIcon,
  SearchIcon,
  SquarePenIcon,
  SunIcon,
  VariableIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"
import { ContributeDialog } from "@/components/contribute-dialog"
import { EditorArea } from "@/components/editor-area"
import { Explorer } from "@/components/explorer"
import { RecipesPage, VariablesPage } from "@/pages/overview-pages"
import { BuildPage, ContextPage } from "@/pages/build-context"
import { ProposalsPage } from "@/pages/proposals"
import { unsentIds, useStore, type Page } from "@/lib/store"
import { cn } from "@/lib/utils"

const NAV: { page: Page; label: string; icon: typeof SquarePenIcon }[] = [
  { page: "editor", label: "Editor", icon: SquarePenIcon },
  { page: "context", label: "Agent view", icon: BotIcon },
  { page: "variables", label: "Variables", icon: VariableIcon },
  { page: "recipes", label: "Recipes", icon: BoxesIcon },
  { page: "build", label: "Build", icon: HammerIcon },
  { page: "proposals", label: "Proposals", icon: GitPullRequestArrowIcon },
]

function Header() {
  const workspace = useStore((s) => s.workspace)
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const docs = useStore((s) => s.docs)
  const proposals = useStore((s) => s.proposals)
  const openContribute = useStore((s) => s.openContribute)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const unsent = unsentIds(docs)
  const openProposals = proposals.filter((p) => p.stage !== "released").length

  const toggleTheme = () => document.documentElement.classList.toggle("dark")

  return (
    <header className="relative flex h-13 shrink-0 items-center gap-3 border-b bg-sidebar px-3">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
      <div className="flex items-center gap-2.5">
        <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 text-white shadow-[var(--shadow-glow)]">
          <ChefHatIcon className="size-[18px]" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-tight">sous</div>
          <div className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">studio</div>
        </div>
        {workspace && (
          <div className="ml-2 flex items-center gap-2 rounded-lg border bg-background/60 py-1 pr-2 pl-2.5">
            <span className="text-sm font-medium">{workspace.projectName}</span>
            <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              <GitBranchIcon className="size-3" />
              {workspace.branch}
            </span>
          </div>
        )}
      </div>
      <nav className="ml-3 flex items-center gap-0.5 rounded-xl border bg-background/50 p-1">
        {NAV.map(({ page: p, label, icon: Icon }) => (
          <button
            key={p}
            onClick={() => setPage(p)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-all",
              page === p
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className={cn("size-3.5", page === p && "text-brand")} /> {label}
            {p === "proposals" && openProposals > 0 && (
              <span className="ml-0.5 rounded-full bg-brand-soft px-1.5 text-[10px] font-semibold text-brand">{openProposals}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="outline" className="w-60 justify-start bg-background/60 text-muted-foreground" onClick={() => setPaletteOpen(true)}>
          <SearchIcon /> Open a file…
          <span className="ml-auto flex gap-0.5">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <Button
          size="sm"
          onClick={() => openContribute()}
          variant={unsent.length ? "default" : "outline"}
          className={cn("font-semibold", unsent.length > 0 && "shadow-[var(--shadow-glow)]")}
        >
          <GitPullRequestArrowIcon />
          {unsent.length ? (
            <>
              Send changes
              <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px]">{unsent.length}</span>
            </>
          ) : (
            "No changes yet"
          )}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={toggleTheme} title="Light or dark">
          <SunIcon className="hidden dark:block" />
          <MoonIcon className="dark:hidden" />
        </Button>
      </div>
    </header>
  )
}

function Palette() {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const files = useStore((s) => s.workspace?.files ?? [])
  const openFile = useStore((s) => s.open)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "p")) {
        e.preventDefault()
        setOpen(!useStore.getState().paletteOpen)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setOpen])

  const groups = [
    { heading: "Samples", items: files.filter((f) => f.origin.kind === "sample") },
    { heading: "This project", items: files.filter((f) => f.origin.kind === "project") },
    { heading: "Recipes", items: files.filter((f) => f.origin.kind === "recipe") },
  ]

  return (
    <CommandDialog open={open} onOpenChange={setOpen} className="sm:max-w-2xl">
      <Command>
      <CommandInput placeholder="Find a source file…" />
      <CommandList>
        <CommandEmpty>No file matches.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.items.map((f) => (
              <CommandItem
                key={f.id}
                value={`${f.display} ${f.outputs.join(" ")}`}
                onSelect={() => {
                  openFile(f.id)
                  setOpen(false)
                }}
              >
                <FileCode2Icon className="text-liquid" />
                <span className="truncate">{f.display}</span>
                {f.outputs[0] && <span className="ml-auto truncate text-xs text-muted-foreground">→ {f.outputs[0]}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      </Command>
    </CommandDialog>
  )
}

export default function App() {
  const load = useStore((s) => s.load)
  const workspace = useStore((s) => s.workspace)
  const loadError = useStore((s) => s.loadError)
  const page = useStore((s) => s.page)

  useEffect(() => {
    load()
  }, [load])

  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <p className="font-medium">Can't reach sous.</p>
          <p className="text-sm text-muted-foreground">
            {loadError}. Open the URL that <code>sous serve</code> printed; it carries the access token.
          </p>
        </div>
      </div>
    )
  }
  if (!workspace) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <LoaderIcon className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background text-foreground">
        <Header />
        <main className="min-h-0 flex-1">
          {page === "editor" && (
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="20%" minSize="12%" maxSize="40%">
                <Explorer />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="80%">
                <EditorArea />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {page === "context" && <ContextPage />}
          {page === "variables" && <VariablesPage />}
          {page === "recipes" && <RecipesPage />}
          {page === "build" && <BuildPage />}
          {page === "proposals" && <ProposalsPage />}
        </main>
      </div>
      <ContributeDialog />
      <Palette />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
