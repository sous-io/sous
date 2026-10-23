import { useEffect, useRef } from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { liquidCompletion } from "./liquid-complete"
import { variableHover } from "./liquid-hover"
import { activeRegion, liquidPreview, previewState, setError, setIncludes, setMode, setOriginal, setRegions } from "./liquid-preview"

const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.45em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--cm-link)" },
  { tag: t.url, color: "var(--cm-link)", opacity: "0.8" },
  { tag: t.monospace, color: "var(--cm-code)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted-foreground)" },
  { tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.list, color: "var(--cm-list)" },
  { tag: t.contentSeparator, color: "var(--muted-foreground)" },
])

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "'Geist Mono Variable', ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0 40vh", caretColor: "var(--foreground)", minWidth: "0" },
  ".cm-line": { padding: "0 24px 0 12px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)", opacity: "0.55" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--cm-liquid) 30%, transparent) !important",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)", borderLeftWidth: "2px" },
})

/** Opens the file an `@include` line names, matched by the end of its path. */
function openInclude(line: string) {
  const { workspace, open } = useStore.getState()
  const wanted = line.replace(/^@/, "").replace(/\?.*$/, "").replace(/\$\{[^}]+\}\/?/g, "").replace(/^[~#][^/]*\//, "")
  const tail = wanted.split("/").filter((p) => p && !p.includes("*")).slice(-2).join("/")
  const candidates = (workspace?.files ?? []).filter((f) => {
    const p = f.path.replace(/\.tpl\./, ".")
    return tail && (p.endsWith("/" + tail) || f.path.endsWith("/" + tail))
  })
  if (candidates[0]) open(candidates[0].id)
}

let scrollTimer: number | undefined

// One editor is mounted per open tab (hidden when inactive), so each file keeps
// its cursor and undo history.
type Props = { fileId: string; visible: boolean }

export function LiquidEditor({ fileId, visible }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef(false)

  const doc = useStore((s) => s.docs[fileId])
  const mode = useStore((s) => s.mode)
  const jump = useStore((s) => s.jump)

  const renderNow = (source: string) => {
    window.clearTimeout(timer.current)
    pending.current = false
    const { setRendering, setRender } = useStore.getState()
    setRendering(fileId, true)
    api
      .render(fileId, source, useStore.getState().docs[fileId]?.overrides)
      .then((result) => setRender(fileId, source, result))
      .catch((error) => setRender(fileId, source, { ...useStore.getState().docs[fileId].render, error: error.message }))
  }

  // Create (or restore) the editor for this file.
  useEffect(() => {
    if (!host.current || !doc) return
    const scheduleRender = (source: string) => {
      pending.current = true
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => renderNow(source), 250)
    }

    const state = EditorState.create({
        doc: doc.current,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(markdownStyle),
          theme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                const f = useStore.getState().workspace?.files.find((x) => x.id === fileId)
                toast(
                  f?.origin.kind === "recipe"
                    ? "Recipe edits stay in this tab until you propose them: press Review changes in the header."
                    : "Saving to disk is turned off in this proof of concept. Your edit stays in this tab.",
                )
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          // Close Liquid delimiters as they're typed: {{ → {{ | }}, {% → {% | %}.
          EditorView.inputHandler.of((v, from, to, text) => {
            const prev = v.state.doc.sliceString(from - 1, from)
            if (prev !== "{" || (text !== "{" && text !== "%")) return false
            const close = text === "{" ? "}}" : "%}"
            if (v.state.doc.sliceString(to, to + 3).trim().startsWith(close)) return false
            v.dispatch({ changes: { from, to, insert: `${text}  ${close}` }, selection: { anchor: from + 2 } })
            return true
          }),
          variableHover(
            () => useStore.getState().docs[fileId]?.vars ?? {},
            () => useStore.getState().varFacts,
          ),
          liquidCompletion(
            () => useStore.getState().docs[fileId]?.vars ?? {},
            () =>
              (useStore.getState().workspace?.files ?? []).flatMap((f) => {
                if (f.id === fileId || !f.display.endsWith(".md")) return []
                const plain = (p: string) => p.replace(/\.tpl\.md$/, ".md")
                if (f.origin.kind === "recipe")
                  return [{ label: `~${f.origin.namespace}/${f.origin.recipe}/${plain(f.origin.recipePath)}`, detail: "recipe file" }]
                if (f.origin.kind === "project" && f.display.startsWith(".sous/"))
                  return [{ label: `\${sousDir}/${plain(f.display.slice(".sous/".length))}`, detail: "this project" }]
                return []
              }),
          ),
          liquidPreview({
            onLeaveRegion: () => {
              if (pending.current && view.current) renderNow(view.current.state.doc.toString())
            },
            onOpenInclude: (line) => openInclude(line),
            onOpenFile: (id) => useStore.getState().open(id),
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const source = update.state.doc.toString()
            useStore.getState().edit(fileId, source)
            scheduleRender(source)
          }),
          EditorView.domEventHandlers({
            scroll(_event, v) {
              // Tell the output pane which section is at the top, so it can follow.
              window.clearTimeout(scrollTimer)
              scrollTimer = window.setTimeout(() => {
                const top = v.lineBlockAtHeight(v.scrollDOM.scrollTop).from
                const regions = v.state.field(previewState).regions
                const index = regions.findIndex((r) => r.to >= top)
                window.dispatchEvent(new CustomEvent("sous-editor-top", { detail: { fileId, index, atTop: v.scrollDOM.scrollTop < 8 } }))
              }, 60)
              return false
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.focusChanged) {
              const region = activeRegion(update.state)
              const regions = update.state.field(previewState).regions
              window.dispatchEvent(
                new CustomEvent("sous-active-region", { detail: region === -1 ? null : regions[region] }),
              )
            }
          }),
        ],
      })

    const v = new EditorView({ state, parent: host.current })
    view.current = v
    v.dispatch({
      effects: [setRegions.of(doc.render.regions), setMode.of(useStore.getState().mode), setOriginal.of(doc.original)],
    })

    return () => {
      window.clearTimeout(timer.current)
      v.destroy()
      view.current = null
    }
    // Only re-run when the file changes or first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, !!doc])

  // A new render arrived: hand its regions to the editor if they match its text.
  useEffect(() => {
    const v = view.current
    if (!v || !doc) return
    if (v.state.doc.toString() !== doc.current || doc.rendering) return
    if (doc.current.includes("@")) {
      const source = doc.current
      api.includes(fileId, source).then((infos) => {
        if (view.current && view.current.state.doc.toString() === source) view.current.dispatch({ effects: setIncludes.of(infos) })
      }).catch(() => {})
    }
    const error = doc.render.error ? { message: doc.render.error, pos: doc.render.errorPos ?? null } : null
    v.dispatch({ effects: doc.render.error ? [setError.of(error)] : [setRegions.of(doc.render.regions), setError.of(null)] })
  }, [doc?.render, doc?.rendering])

  // Revert (or any outside change to the text) replaces the editor's text.
  useEffect(() => {
    const v = view.current
    if (!v || !doc) return
    if (v.state.doc.toString() !== doc.current) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.current } })
    }
  }, [doc?.current])

  useEffect(() => {
    view.current?.dispatch({ effects: setMode.of(mode) })
  }, [mode])

  // The output pane asked to jump to a region.
  useEffect(() => {
    const v = view.current
    if (!v || !jump || jump.id !== fileId) return
    const region = v.state.field(previewState).regions[jump.region]
    if (!region) return
    v.focus()
    v.dispatch({ selection: { anchor: region.from }, scrollIntoView: true })
    window.setTimeout(() => v.dispatch({ selection: { anchor: region.from }, scrollIntoView: true }), 0)
  }, [jump])

  useEffect(() => {
    if (visible) view.current?.requestMeasure()
  }, [visible])

  return <div ref={host} className="h-full overflow-hidden" style={{ display: visible ? undefined : "none" }} />
}
