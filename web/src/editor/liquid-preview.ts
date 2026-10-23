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

/** `{% if x %}` -> `if x`; `{{ a | b }}` -> `a | b`. */
function inner(head: string): string {
  return head.replace(/^\{[{%]-?\s*/, "").replace(/\s*-?[}%]\}$/, "")
}

function onActivate(el: HTMLElement, view: EditorView, region: Region) {
  el.addEventListener("mousedown", (event) => {
    event.preventDefault()
    // Focus first: focusing reads the DOM selection and would move the cursor.
    view.focus()
    view.dispatch({ selection: { anchor: region.from }, scrollIntoView: true })
    // The focus change reads the DOM selection a moment later; set it again after that.
    window.setTimeout(() => view.dispatch({ selection: { anchor: region.from } }), 0)
  })
}

/** An `{{ output }}` or inline tag inside a line: just its rendered text. */
class InlineWidget extends WidgetType {
  constructor(
    readonly region: Region,
    readonly fresh: boolean,
  ) {
    super()
  }

  eq(other: InlineWidget): boolean {
    return (
      other.region.rendered === this.region.rendered &&
      other.region.from === this.region.from &&
      other.region.head === this.region.head &&
      other.fresh === this.fresh
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const { region } = this
    const el = document.createElement("span")
    el.className = `cm-liquid-rendered cm-liquid-${region.kind}` + (this.fresh ? " cm-liquid-fresh" : "")
    el.dataset.src = region.head
    if (region.rendered === "") {
      el.classList.add("cm-liquid-empty")
      el.textContent = region.kind === "output" ? `∅ ${region.label}` : inner(region.head)
    } else {
      el.textContent = region.rendered
    }
    onActivate(el, view, region)
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const QUIET_TAGS = new Set(["assign", "capture", "comment", "#", "getFiles", "increment", "decrement"])

/** A section that fills whole lines: a card with its opening tag and its output. */
class BlockWidget extends WidgetType {
  constructor(
    readonly region: Region,
    readonly fresh: boolean,
  ) {
    super()
  }

  eq(other: BlockWidget): boolean {
    return (
      other.region.rendered === this.region.rendered &&
      other.region.from === this.region.from &&
      other.region.head === this.region.head &&
      other.fresh === this.fresh
    )
  }

  get estimatedHeight(): number {
    return -1
  }

  toDOM(view: EditorView): HTMLElement {
    const { region } = this
    const body = region.rendered.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "")
    const quiet = body.trim() === "" && (QUIET_TAGS.has(region.label) || region.kind === "tag")

    const el = document.createElement("div")
    el.className = `cm-liquid-card${quiet ? " cm-liquid-card-quiet" : ""}${this.fresh ? " cm-liquid-fresh" : ""}`

    const head = document.createElement("div")
    head.className = "cm-liquid-card-head"
    const chip = document.createElement("span")
    chip.className = "cm-liquid-chip"
    chip.textContent = region.kind === "output" ? "{{ }}" : region.label
    const code = document.createElement("code")
    const rest = region.kind === "output" ? inner(region.head) : inner(region.head).slice(region.label.length).trim()
    code.textContent = rest
    head.append(chip, code)
    if (!quiet) {
      const hint = document.createElement("span")
      hint.className = "cm-liquid-card-hint"
      hint.textContent = "click to edit"
      head.append(hint)
    }
    el.append(head)

    if (!quiet) {
      const content = document.createElement("div")
      content.className = "cm-liquid-card-body"
      if (body.trim() === "") {
        content.classList.add("cm-liquid-card-empty")
        content.textContent = "renders nothing here"
      } else {
        content.textContent = body
      }
      el.append(content)
    }
    onActivate(el, view, region)
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const activeMark = Decoration.mark({ class: "cm-liquid-active" })
const sourceMark = Decoration.mark({ class: "cm-liquid-source" })

/** True when the region starts at a line start and ends at a line end. */
function fillsLines(state: EditorState, region: Region): boolean {
  const first = state.doc.lineAt(region.from)
  const last = state.doc.lineAt(region.to)
  return region.from === first.from && region.to === last.to
}

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
    } else if (fillsLines(state, region) && (region.kind !== "output" || region.rendered.includes("\n"))) {
      ranges.push(
        Decoration.replace({ widget: new BlockWidget(region, fresh.has(index)), block: true }).range(region.from, region.to),
      )
    } else {
      ranges.push(Decoration.replace({ widget: new InlineWidget(region, fresh.has(index)) }).range(region.from, region.to))
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
