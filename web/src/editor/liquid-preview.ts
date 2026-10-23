// CodeMirror extension: shows each top-level Liquid section as its rendered
// output, and its Liquid source while the cursor is inside it.
//
// The document is always the template source. The server reports each
// section's position and rendered text (a "region"); this extension draws a
// widget over every region except the one being edited.

import { EditorState, Range, StateEffect, StateField, type Extension } from "@codemirror/state"
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import type { Region } from "@/lib/api"

export type PreviewMode = "rendered" | "source"

type PreviewState = {
  regions: Region[]
  /** Regions whose rendered text changed in the last render, to flash them. */
  fresh: Set<number>
  mode: PreviewMode
  focused: boolean
}

export const setRegions = StateEffect.define<Region[]>()
export const setMode = StateEffect.define<PreviewMode>()
const setFocused = StateEffect.define<boolean>()

export const previewState = StateField.define<PreviewState>({
  create: () => ({ regions: [], fresh: new Set(), mode: "rendered", focused: false }),
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // Keep regions in place while typing; the next render replaces them.
      const regions = next.regions.map((r) => ({
        ...r,
        from: tr.changes.mapPos(r.from, -1),
        to: tr.changes.mapPos(r.to, 1),
      }))
      next = { ...next, regions: regions.filter((r) => r.to > r.from), fresh: new Set() }
    }
    for (const effect of tr.effects) {
      if (effect.is(setRegions)) {
        const fresh = new Set<number>()
        effect.value.forEach((r, i) => {
          const before = next.regions[i]
          if (before && before.rendered !== r.rendered) fresh.add(i)
        })
        next = { ...next, regions: effect.value, fresh }
      }
      if (effect.is(setMode)) next = { ...next, mode: effect.value }
      if (effect.is(setFocused)) next = { ...next, focused: effect.value }
    }
    return next
  },
})

/** The region the cursor is in, if any. */
export function activeRegion(state: EditorState): number {
  const { regions, focused } = state.field(previewState)
  if (!focused) return -1
  const sel = state.selection.main
  return regions.findIndex((r) => sel.to >= r.from && sel.from < r.to)
}

class RenderedWidget extends WidgetType {
  constructor(
    readonly region: Region,
    readonly fresh: boolean,
  ) {
    super()
  }

  eq(other: RenderedWidget): boolean {
    return (
      other.region.rendered === this.region.rendered &&
      other.region.from === this.region.from &&
      other.region.label === this.region.label &&
      other.fresh === this.fresh
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const { region } = this
    const el = document.createElement("span")
    el.className = `cm-liquid-rendered cm-liquid-${region.kind}` + (this.fresh ? " cm-liquid-fresh" : "")
    el.title = `${region.kind === "output" ? `{{ ${region.label} }}` : `{% ${region.label} %}`} — click to edit the Liquid source`

    if (region.rendered === "") {
      el.classList.add("cm-liquid-empty")
      el.textContent = region.kind === "output" ? `∅ ${region.label}` : `${region.label}`
    } else {
      el.textContent = region.rendered
    }

    el.addEventListener("mousedown", (event) => {
      event.preventDefault()
      // Focus first: focusing reads the DOM selection and would move the cursor.
      view.focus()
      view.dispatch({ selection: { anchor: region.from }, scrollIntoView: true })
      // The focus change reads the DOM selection a moment later; set it again after that.
      window.setTimeout(() => view.dispatch({ selection: { anchor: region.from } }), 0)
    })
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const activeMark = Decoration.mark({ class: "cm-liquid-active" })
const sourceMark = Decoration.mark({ class: "cm-liquid-source" })

function buildDecorations(state: EditorState): DecorationSet {
  const { regions, mode, fresh } = state.field(previewState)
  const active = activeRegion(state)
  const ranges: Range<Decoration>[] = []
  const docLength = state.doc.length

  regions.forEach((region, index) => {
    if (region.to > docLength) return
    if (mode === "source") {
      ranges.push(sourceMark.range(region.from, region.to))
    } else if (index === active) {
      ranges.push(activeMark.range(region.from, region.to))
    } else {
      ranges.push(Decoration.replace({ widget: new RenderedWidget(region, fresh.has(index)) }).range(region.from, region.to))
    }
  })
  return Decoration.set(ranges, true)
}

const decorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    const changed =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setRegions) || e.is(setMode) || e.is(setFocused))
    return changed ? buildDecorations(tr.state) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

// Liquid delimiters anywhere in the text get a colour, so new Liquid that the
// server has not reported yet still stands out.
const liquidSyntax = new MatchDecorator({
  regexp: /\{\{-?[\s\S]*?-?\}\}|\{%-?[\s\S]*?-?%\}/g,
  decoration: Decoration.mark({ class: "cm-liquid-syntax" }),
})

const includeSyntax = new MatchDecorator({
  regexp: /^@[~#a-zA-Z0-9_.${}*?[][\w\-/.:${}*?[\],!~#%+^()]*\.md\S*$/gm,
  decoration: Decoration.mark({ class: "cm-include-line" }),
})

function highlighter(decorator: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view)
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

export type PreviewCallbacks = {
  /** Called when the cursor leaves a region, or the editor loses focus. */
  onLeaveRegion: () => void
}

export function liquidPreview(callbacks: PreviewCallbacks): Extension {
  return [
    previewState,
    decorations,
    highlighter(liquidSyntax),
    highlighter(includeSyntax),
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    EditorView.updateListener.of((update) => {
      const before = activeRegion(update.startState)
      const after = activeRegion(update.state)
      if (before !== -1 && before !== after) callbacks.onLeaveRegion()
    }),
  ]
}
