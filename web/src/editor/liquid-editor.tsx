import { useEffect, useRef } from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { activeRegion, liquidPreview, previewState, setMode, setRegions } from "./liquid-preview"

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
  "&": { height: "100%", fontSize: "13.5px", backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "'Geist Mono Variable', ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0 40vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 24px 0 12px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)", opacity: "0.55" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--cm-liquid) 30%, transparent) !important",
  },
  "&.cm-focused": { outline: "none" },
})

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
      .render(fileId, source)
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
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          liquidPreview({
            onLeaveRegion: () => {
              if (pending.current && view.current) renderNow(view.current.state.doc.toString())
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const source = update.state.doc.toString()
            useStore.getState().edit(fileId, source)
            scheduleRender(source)
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
    v.dispatch({ effects: [setRegions.of(doc.render.regions), setMode.of(useStore.getState().mode)] })

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
    if (v.state.doc.toString() === doc.current && !doc.rendering && !doc.render.error) {
      v.dispatch({ effects: setRegions.of(doc.render.regions) })
    }
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
