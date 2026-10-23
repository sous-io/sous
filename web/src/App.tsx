import { useEffect } from "react"
import {
  BotIcon,
  HouseIcon,
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
import { RecipesPage } from "@/pages/recipes-page"
import { VariablesPage } from "@/pages/variables-page"
import { HomePage } from "@/pages/home-page"
import { BuildPage, ContextPage } from "@/pages/build-context"
import { ProposalsPage } from "@/pages/proposals"
import { unsentIds, useStore, type Page } from "@/lib/store"
import { cn } from "@/lib/utils"

const NAV: { page: Page; label: string; icon: typeof SquarePenIcon }[] = [
  { page: "home", label: "Home", icon: HouseIcon },
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

  const toggleTheme = () => {
    const dark = document.documentElement.classList.toggle("dark")
    try {
      localStorage.setItem("sous-theme", dark ? "dark" : "light")
    } catch {
      // The theme just isn't remembered.
    }
  }

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
            <span className="flex max-w-44 items-center gap-1 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground max-[1200px]:hidden">
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
            <Icon className={cn("size-3.5", page === p && "text-brand")} /> <span className="max-[1380px]:hidden">{label}</span>
            {p === "proposals" && openProposals > 0 && (
              <span className="ml-0.5 rounded-full bg-brand-soft px-1.5 text-[10px] font-semibold text-brand">{openProposals}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="outline" className="w-60 justify-start bg-background/60 text-muted-foreground max-[1380px]:w-auto" onClick={() => setPaletteOpen(true)}>
          <SearchIcon /> <span className="max-[1380px]:hidden">Open a file…</span>
          <span className="ml-auto flex gap-0.5 max-[1380px]:hidden">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <Button
          size="sm"
          onClick={() => openContribute()}
          variant={unsent.length ? "default" : "outline"}
          disabled={unsent.length === 0}
          title={unsent.length === 0 ? "Edit any file to start a proposal" : undefined}
          className={cn("shrink-0 font-semibold", unsent.length > 0 && "shadow-[var(--shadow-glow)]")}
        >
          <GitPullRequestArrowIcon />
          {unsent.length ? (
            <>
              Send changes
              <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[11px]">{unsent.length}</span>
            </>
          ) : (
            "Nothing to send"
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

  const run = (fn: () => void) => {
    fn()
    setOpen(false)
  }
  const state = useStore.getState
  const commands: { label: string; hint: string; icon: typeof SquarePenIcon; run: () => void }[] = [
    { label: "Send changes upstream", hint: "Open the send dialog", icon: GitPullRequestArrowIcon, run: () => state().openContribute() },
    { label: "Show rendered Liquid", hint: "Editor mode", icon: SquarePenIcon, run: () => state().setMode("rendered") },
    { label: "Show template source", hint: "Editor mode", icon: FileCode2Icon, run: () => state().setMode("source") },
    { label: "Check the build again", hint: "Rebuild into a temporary folder", icon: HammerIcon, run: () => state().rebuild() },
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, hint: "Page", icon: n.icon, run: () => state().setPage(n.page) })),
    { label: "Switch light or dark", hint: "Theme", icon: SunIcon, run: () => document.querySelector<HTMLButtonElement>("[title='Light or dark']")?.click() },
  ]
  const groups = [
    { heading: "Samples", items: files.filter((f) => f.origin.kind === "sample") },
    { heading: "This project", items: files.filter((f) => f.origin.kind === "project") },
    { heading: "Recipes", items: files.filter((f) => f.origin.kind === "recipe") },
  ]

  return (
    <CommandDialog open={open} onOpenChange={setOpen} className="sm:max-w-2xl">
      <Command>
        <CommandInput placeholder="Open a file, or run a command…" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Commands">
            {commands.map((c) => (
              <CommandItem key={c.label} value={`> ${c.label}`} onSelect={() => run(c.run)}>
                <c.icon className="text-brand" />
                <span>{c.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{c.hint}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {groups.map((g) => (
            <CommandGroup key={g.heading} heading={g.heading}>
              {g.items.map((f) => (
                <CommandItem key={f.id} value={`${f.display} ${f.outputs.join(" ")}`} onSelect={() => run(() => openFile(f.id))}>
                  <FileCode2Icon className="text-liquid" />
                  <span className="truncate">{f.display}</span>
                  {f.outputs[0] && (
                    <span className="ml-auto max-w-[45%] truncate text-right text-xs text-muted-foreground" style={{ direction: "rtl" }}>
                      → {f.outputs[0]}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
          <span className="ml-auto">Searches source paths and the outputs they build</span>
        </div>
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
          {page === "home" && <HomePage />}
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
