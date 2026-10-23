// A short guided tour of what the GUI can do. Each step opens the right page
// (and file), then points at one element.

import { useEffect, useState } from "react"
import { create } from "zustand"
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore, type Page } from "@/lib/store"

type Step = {
  page: Page
  file?: string
  /** CSS selector of the element to point at; the step is centred when it is missing. */
  target?: string
  title: string
  body: string
  /** Run before the step is shown, e.g. switch an inspector tab. */
  before?: () => void
}

const click = (selector: string) => () => window.setTimeout(() => document.querySelector<HTMLElement>(selector)?.click(), 150)

const STEPS: Step[] = [
  {
    page: "home",
    target: "[data-tour=attention]",
    title: "What needs you",
    body: "Everything here is read from this project: outputs that fail to build, variables with no value, recipe updates already downloaded.",
  },
  {
    page: "editor",
    file: "sample",
    target: ".cm-liquid-card:not(.cm-liquid-card-quiet)",
    title: "Liquid, rendered",
    body: "Each Liquid section shows what it renders to, with this project's real variables. Cards say which branch ran, or how many times a loop ran.",
  },
  {
    page: "editor",
    file: "sample",
    target: ".cm-liquid-rendered",
    title: "Click to edit",
    body: "Click any section to edit its Liquid. While you type, a chip shows the result; Esc renders it again. Typing {{ gives autocomplete with real values.",
  },
  {
    page: "editor",
    file: "sample",
    target: "[data-tour=inspector]",
    title: "The result, side by side",
    body: "Text, a markdown Preview, and What changed: a diff of what your agent will read. Click a highlighted piece to jump to the Liquid that wrote it.",
  },
  {
    page: "editor",
    file: "sample",
    target: "[data-tour=inspector]",
    before: click("[data-tour=tab-vars]"),
    title: "Try another value",
    body: "Click any value and type another one. The whole file re-renders; nothing is saved. Change openPullRequests to never and watch the if card switch branches.",
  },
  {
    page: "editor",
    file: "sample",
    target: "[data-tour=drift]",
    title: "Hand edits, rescued",
    body: "When someone (often an agent) edits a built file directly, the next build throws it away. sous finds each edit and moves it into the template.",
  },
  {
    page: "editor",
    file: "sample",
    target: "[data-tour=send]",
    title: "Send it upstream",
    body: "Edit a recipe file and this button turns your edits into a pull request: checks, diff against upstream, version raise and description, in one dialog.",
  },
  {
    page: "context",
    target: "[data-tour=context-hero]",
    title: "What your agent reads",
    body: "Tokens read at the start of every session, and what's read only when needed, from a fresh build of every output.",
  },
  {
    page: "recipes",
    title: "Recipes",
    body: "The recipes this project uses and the others already downloaded, read from each recipe's sous.recipe.yaml, with updates ready to apply.",
  },
  {
    page: "proposals",
    title: "Your pull requests",
    body: "Your real pull requests on these repositories, live from GitHub, and the ones you sent from here. Ctrl+K opens any file or command from anywhere.",
  },
]

export const useTour = create<{ step: number | null; start: () => void; stop: () => void; go: (n: number) => void }>((set) => ({
  step: null,
  start: () => {
    try {
      localStorage.setItem("sous-tip-seen", "1")
    } catch {
      // The tip may show again next time.
    }
    set({ step: 0 })
  },
  stop: () => set({ step: null }),
  go: (step) => set({ step }),
}))

export function Tour() {
  const step = useTour((s) => s.step)
  const go = useTour((s) => s.go)
  const stop = useTour((s) => s.stop)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const current = step === null ? null : STEPS[step]

  useEffect(() => {
    if (!current) return
    const state = useStore.getState()
    if (current.file) state.open(current.file)
    else state.setPage(current.page)
    current.before?.()
  }, [step])

  useEffect(() => {
    if (!current?.target) {
      setRect(null)
      return
    }
    const find = () => {
      const el = document.querySelector(current.target!)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    find()
    const t = window.setInterval(find, 250)
    return () => window.clearInterval(t)
  }, [step])

  useEffect(() => {
    if (step === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop()
      if (e.key === "ArrowRight") go(Math.min(step + 1, STEPS.length - 1))
      if (e.key === "ArrowLeft") go(Math.max(step - 1, 0))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step])

  if (!current || step === null) return null

  const pad = 8
  const box = rect ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: Math.min(rect.height + pad * 2, window.innerHeight - rect.top) } : null
  // Put the card beside the target where it fits: below, above, right, left, else over it.
  const W = 380
  const H = 210
  const vw = window.innerWidth
  const vh = window.innerHeight
  const clampX = (x: number) => Math.min(Math.max(x, 16), vw - W - 16)
  const clampY = (y: number) => Math.min(Math.max(y, 16), vh - H - 16)
  let cardStyle: React.CSSProperties = { left: "50%", top: "40%", transform: "translate(-50%, -50%)" }
  if (box) {
    if (box.top + box.height + 12 + H < vh) cardStyle = { left: clampX(box.left), top: box.top + box.height + 12 }
    else if (box.top - 12 - H > 0) cardStyle = { left: clampX(box.left), top: box.top - 12 - H }
    else if (box.left + box.width + 12 + W < vw) cardStyle = { left: box.left + box.width + 12, top: clampY(box.top) }
    else if (box.left - 12 - W > 0) cardStyle = { left: box.left - 12 - W, top: clampY(box.top) }
    else cardStyle = { left: clampX(box.left + 24), top: clampY(box.top + 24) }
  }

  return (
    <div className="fixed inset-0 z-[100]">
      {box ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-brand transition-all duration-300"
          style={{ ...box, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)" }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}
      <div className="absolute w-[380px] rounded-xl border bg-popover p-4 shadow-2xl transition-all duration-300" style={cardStyle}>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wider text-brand uppercase">
            {step + 1} of {STEPS.length}
          </span>
          <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={stop} aria-label="End the tour">
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="font-semibold">{current.title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{current.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-brand" : "w-1.5 bg-muted-foreground/30"}`} />
            ))}
          </div>
          {step > 0 && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => go(step - 1)}>
              <ArrowLeftIcon /> Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button size="sm" className={step === 0 ? "ml-auto" : ""} onClick={() => go(step + 1)}>
              Next <ArrowRightIcon />
            </Button>
          ) : (
            <Button size="sm" onClick={stop}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
