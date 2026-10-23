import { create } from "zustand"
import { api, type RenderResult, type WorkspaceInfo } from "./api"
import { SEED_PROPOSALS, type Proposal } from "@/mock/data"

export type Page = "editor" | "variables" | "recipes" | "build" | "proposals"
export type Mode = "rendered" | "source"

export type OpenDoc = {
  original: string
  current: string
  vars: Record<string, string>
  render: RenderResult
  rendering: boolean
  /** Set once the edit has been proposed upstream (mock). */
  proposedIn?: string
}

type State = {
  workspace: WorkspaceInfo | null
  loadError: string | null
  page: Page
  mode: Mode
  showOutput: boolean
  tabs: string[]
  activeId: string | null
  docs: Record<string, OpenDoc>
  contributeOpen: boolean
  contributeFocus: string | null
  paletteOpen: boolean
  proposals: Proposal[]
  /** Region index the output pane asked the editor to jump to. */
  jump: { id: string; region: number; nonce: number } | null

  load: () => Promise<void>
  setPage: (page: Page) => void
  setMode: (mode: Mode) => void
  toggleOutput: () => void
  open: (id: string) => Promise<void>
  close: (id: string) => void
  edit: (id: string, source: string) => void
  setRender: (id: string, source: string, render: RenderResult) => void
  setRendering: (id: string, rendering: boolean) => void
  revert: (id: string) => void
  openContribute: (focus?: string | null) => void
  closeContribute: () => void
  setPaletteOpen: (open: boolean) => void
  addProposal: (proposal: Proposal, fileIds: string[]) => void
  jumpTo: (id: string, region: number) => void
}

export const useStore = create<State>((set, get) => ({
  workspace: null,
  loadError: null,
  page: "editor",
  mode: "rendered",
  showOutput: true,
  tabs: [],
  activeId: null,
  docs: {},
  contributeOpen: false,
  contributeFocus: null,
  paletteOpen: false,
  proposals: SEED_PROPOSALS,
  jump: null,

  load: async () => {
    try {
      const workspace = await api.workspace()
      set({ workspace })
      await get().open("sample")
    } catch (error) {
      set({ loadError: (error as Error).message })
    }
  },
  setPage: (page) => set({ page }),
  setMode: (mode) => set({ mode }),
  toggleOutput: () => set((s) => ({ showOutput: !s.showOutput })),
  open: async (id) => {
    const { tabs, docs } = get()
    set({ activeId: id, page: "editor", tabs: tabs.includes(id) ? tabs : [...tabs, id] })
    if (docs[id]) return
    const payload = await api.file(id)
    set((s) => ({
      docs: {
        ...s.docs,
        [id]: {
          original: payload.content,
          current: payload.content,
          vars: payload.vars,
          render: payload.render,
          rendering: false,
        },
      },
    }))
  },
  close: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t !== id)
      const index = s.tabs.indexOf(id)
      const activeId = s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : s.activeId
      return { tabs, activeId }
    }),
  edit: (id, source) =>
    set((s) => ({ docs: { ...s.docs, [id]: { ...s.docs[id], current: source, proposedIn: undefined } } })),
  setRender: (id, source, render) =>
    set((s) => {
      const doc = s.docs[id]
      if (!doc || doc.current !== source) return {}
      // A template that fails to render (often half-typed Liquid) keeps the last
      // good render on screen, with the error alongside it.
      const next = render.error ? { ...doc.render, error: render.error, ms: render.ms } : render
      return { docs: { ...s.docs, [id]: { ...doc, render: next, rendering: false } } }
    }),
  setRendering: (id, rendering) =>
    set((s) => (s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], rendering } } } : {})),
  revert: (id) =>
    set((s) => ({ docs: { ...s.docs, [id]: { ...s.docs[id], current: s.docs[id].original, proposedIn: undefined } } })),
  openContribute: (focus = null) => set({ contributeOpen: true, contributeFocus: focus }),
  closeContribute: () => set({ contributeOpen: false }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  addProposal: (proposal, fileIds) =>
    set((s) => {
      const docs = { ...s.docs }
      for (const id of fileIds) if (docs[id]) docs[id] = { ...docs[id], proposedIn: proposal.id }
      return { proposals: [proposal, ...s.proposals], docs }
    }),
  jumpTo: (id, region) => set({ jump: { id, region, nonce: Date.now() } }),
}))

/** Ids of open files whose text differs from what is on disk. */
export function changedIds(docs: Record<string, OpenDoc>): string[] {
  return Object.entries(docs)
    .filter(([, d]) => d.current !== d.original)
    .map(([id]) => id)
}
