// CodeMirror extension: shows each top-level Liquid section as its rendered
// output, and its Liquid source while the cursor is inside it.
//
// The document is always the template source. The server reports each
// section's position and rendered text (a "region"); this extension draws a
// widget over every region except the one being edited.

import { EditorState, Prec, Range, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  lineNumberWidgetMarker,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view"
import { completionStatus } from "@codemirror/autocomplete"
import { syntaxTree } from "@codemirror/language"
import { diffLines } from "diff"
import type { Region } from "@/lib/api"

export type PreviewMode = "rendered" | "source"

export type RenderError = { message: string; pos: number | null }

type PreviewState = {
  regions: Region[]
  /** Regions whose rendered text changed in the last render, to flash them. */
  fresh: Set<number>
  mode: PreviewMode
  focused: boolean
  error: RenderError | null
}

export const setRegions = StateEffect.define<Region[]>()
export const setMode = StateEffect.define<PreviewMode>()
export const setError = StateEffect.define<RenderError | null>()
const setFocused = StateEffect.define<boolean>()

export const previewState = StateField.define<PreviewState>({
  create: () => ({ regions: [], fresh: new Set(), mode: "rendered", focused: false, error: null }),
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // Keep regions in place while typing; the next render replaces them.
      const regions = next.regions.map((r) => ({
        ...r,
        from: tr.changes.mapPos(r.from, -1),
        to: tr.changes.mapPos(r.to, 1),
      }))
      const error = next.error?.pos != null ? { ...next.error, pos: tr.changes.mapPos(next.error.pos) } : next.error
      next = { ...next, regions: regions.filter((r) => r.to > r.from), fresh: new Set(), error }
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
      if (effect.is(setError)) next = { ...next, error: effect.value }
    }
    return next
  },
})

/** The region the cursor is in, if any. */
export function activeRegion(state: EditorState): number {
  const { regions, focused, mode } = state.field(previewState)
  if (!focused || mode === "source") return -1
  const sel = state.selection.main
  return regions.findIndex((r) => sel.to >= r.from && sel.from < r.to)
}

/** `{% if x %}` -> `if x`; `{{ a | b }}` -> `a | b`. */
function inner(head: string): string {
  return head.replace(/^\{[{%]-?\s*/, "").replace(/\s*-?[}%]\}$/, "")
}

/** Where the caret goes when a section is clicked: at the end of its expression or tag arguments. */
function caretFor(state: EditorState, region: Region): number {
  const headEnd = region.kind === "output" ? region.to : region.from + region.head.length
  let pos = headEnd - 2
  const text = state.doc.sliceString(region.from, headEnd)
  let i = text.length - 2
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "-")) {
    i--
    pos--
  }
  return Math.max(region.from, pos)
}

/** What a branching block did with these values: "×5" for a loop, "else · 1 other" for an if. */
function branchNote(state: EditorState, region: Region): string | null {
  if (region.ran && region.branches) {
    if (region.label === "for" || region.label === "tablerow") {
      const loops = region.ran[0] ?? 0
      const elseRan = region.ran.length > 1 && region.ran[1] > 0
      return elseRan ? "empty: else ran" : `×${loops}`
    }
    const taken = region.ran.findIndex((n) => n > 0)
    const others = region.branches.length - (taken === -1 ? 0 : 1)
    if (taken === -1) return `no branch ran${region.branches.length > 1 ? ` · ${region.branches.length} hidden` : ""}`
    const label = taken === 0 && region.label !== "case" ? "first branch" : inner(region.branches[taken])
    return others > 0 ? `showing ${label} · ${others} hidden` : null
  }
  if (!["if", "unless", "case"].includes(region.label)) return null
  const src = state.doc.sliceString(region.from, region.to)
  const branches = (src.match(/\{%-?\s*(elsif|else|when)\b/g) ?? []).length
  const hidden = region.label === "case" ? Math.max(branches - 1, 0) : branches
  if (hidden === 0) return null
  return `+${hidden} hidden branch${hidden === 1 ? "" : "es"}`
}

function onActivate(el: HTMLElement, view: EditorView, caret: number) {
  el.addEventListener("mousedown", (event) => {
    event.preventDefault()
    // Focus first: focusing reads the DOM selection and would move the cursor.
    view.focus()
    view.dispatch({ selection: { anchor: caret }, scrollIntoView: true })
    // The focus change reads the DOM selection a moment later; set it again after that.
    window.setTimeout(() => view.dispatch({ selection: { anchor: caret } }), 0)
  })
}

type WidgetOpts = { fresh: boolean; caret: number; error: string | null; note: string | null; line: string; marks: string }

/** CSS classes for the markdown a section sits inside (heading, bold, inline code), so its output matches. */
function contextMarks(state: EditorState, pos: number): string {
  const marks: string[] = []
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    const n = node.name
    if (n === "InlineCode") marks.push("cm-in-code")
    else if (n === "StrongEmphasis") marks.push("cm-in-strong")
    else if (n === "Emphasis") marks.push("cm-in-em")
    else if (/^(ATX|Setext)Heading(\d)$/.test(n)) marks.push(`cm-in-h${n.slice(-1)}`)
  }
  return marks.join(" ")
}

/** An `{{ output }}` or inline tag inside a line: just its rendered text. */
class InlineWidget extends WidgetType {
  constructor(
    readonly region: Region,
    readonly opts: WidgetOpts,
  ) {
    super()
  }

  eq(other: InlineWidget): boolean {
    return (
      other.region.rendered === this.region.rendered &&
      other.region.from === this.region.from &&
      other.region.head === this.region.head &&
      other.opts.fresh === this.opts.fresh &&
      other.opts.error === this.opts.error &&
      other.opts.marks === this.opts.marks
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const { region, opts } = this
    const el = document.createElement("span")
    el.className =
      `cm-liquid-rendered cm-liquid-${region.kind} ${opts.marks}` + (opts.fresh ? " cm-liquid-fresh" : "") + (opts.error ? " cm-liquid-error" : "")
    el.dataset.src = opts.error ? `⚠ ${opts.error}` : region.head
    if (region.rendered === "") {
      el.classList.add("cm-liquid-empty")
      el.textContent = region.kind === "output" ? `∅ ${region.label}` : inner(region.head)
    } else {
      el.textContent = region.rendered
    }
    onActivate(el, view, opts.caret)
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
    readonly opts: WidgetOpts,
  ) {
    super()
  }

  eq(other: BlockWidget): boolean {
    return (
      other.region.rendered === this.region.rendered &&
      other.region.from === this.region.from &&
      other.region.head === this.region.head &&
      other.opts.fresh === this.opts.fresh &&
      other.opts.error === this.opts.error &&
      other.opts.note === this.opts.note
    )
  }

  get estimatedHeight(): number {
    return -1
  }

  toDOM(view: EditorView): HTMLElement {
    const { region, opts } = this
    const body = region.rendered.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "")
    const quiet = body.trim() === "" && (QUIET_TAGS.has(region.label) || region.kind === "tag") && !opts.error

    const outer = document.createElement("div")
    outer.className = "cm-liquid-card-wrap"
    const el = document.createElement("div")
    el.className =
      `cm-liquid-card${quiet ? " cm-liquid-card-quiet" : ""}` + (opts.fresh ? " cm-liquid-fresh" : "") + (opts.error ? " cm-liquid-card-error" : "")
    outer.append(el)

    const head = document.createElement("div")
    head.className = "cm-liquid-card-head"
    const chip = document.createElement("span")
    chip.className = "cm-liquid-chip"
    chip.textContent = region.kind === "output" ? "{{ }}" : region.label
    const code = document.createElement("code")
    const rest = region.kind === "output" ? inner(region.head) : inner(region.head).slice(region.label.length).trim()
    code.textContent = rest
    code.title = region.head
    head.append(chip, code)
    if (opts.note) {
      const note = document.createElement("span")
      note.className = "cm-liquid-card-note"
      note.textContent = opts.note
      note.title = "This block has other branches; their text didn't render with these values. Click to see them."
      head.append(note)
    }
    if (opts.error) {
      const err = document.createElement("span")
      err.className = "cm-liquid-card-errmsg"
      err.textContent = `⚠ ${opts.error}`
      head.append(err)
    } else if (!quiet) {
      const hint = document.createElement("span")
      hint.className = "cm-liquid-card-hint"
      hint.textContent = "✎ edit"
      head.append(hint)
    }
    el.append(head)

    if (!quiet) {
      const content = document.createElement("div")
      content.className = "cm-liquid-card-body"
      if (body.trim() === "") {
        content.classList.add("cm-liquid-card-empty")
        content.textContent = "renders nothing with these values"
      } else {
        content.textContent = body
      }
      el.append(content)
    }
    onActivate(el, view, opts.caret)
    return outer
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** The slim bar above a block being edited. */
class EditingBar extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(other: EditingBar) {
    return other.label === this.label
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div")
    el.className = "cm-liquid-bar-wrap"
    el.innerHTML = `<div class="cm-liquid-editbar"><span class="cm-liquid-chip"></span><span>Editing Liquid</span><span class="cm-liquid-editbar-keys"><kbd>Esc</kbd> or click outside to finish</span></div>`
    el.querySelector(".cm-liquid-chip")!.textContent = this.label
    return el
  }
}

/** The live result under a block being edited. */
class ResultBar extends WidgetType {
  constructor(
    readonly text: string,
    readonly error: string | null,
  ) {
    super()
  }
  eq(other: ResultBar) {
    return other.text === this.text && other.error === this.error
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div")
    wrap.className = "cm-liquid-bar-wrap"
    const el = document.createElement("div")
    wrap.append(el)
    el.className = "cm-liquid-resultbar" + (this.error ? " cm-liquid-resultbar-error" : "")
    const label = document.createElement("div")
    label.className = "cm-liquid-resultbar-label"
    label.textContent = this.error ? "⚠ Doesn't render" : "Renders as"
    const body = document.createElement("div")
    body.className = "cm-liquid-resultbar-body"
    body.textContent = this.error ?? (this.text.replace(/^\s*\n/, "").replace(/\n\s*$/, "") || "(nothing)")
    el.append(label, body)
    return wrap
  }
}

const activeMark = Decoration.mark({ class: "cm-liquid-active" })
const activeErrorMark = Decoration.mark({ class: "cm-liquid-active cm-liquid-active-error" })
const sourceMark = Decoration.mark({ class: "cm-liquid-source" })
const errorLine = Decoration.line({ class: "cm-liquid-error-line" })

/** True when the region starts at a line start and ends at a line end. */
function fillsLines(state: EditorState, region: Region): boolean {
  const first = state.doc.lineAt(region.from)
  const last = state.doc.lineAt(region.to)
  return region.from === first.from && region.to === last.to
}

function buildDecorations(state: EditorState): DecorationSet {
  const { regions, mode, fresh, error } = state.field(previewState)
  const active = activeRegion(state)
  const ranges: Range<Decoration>[] = []
  const docLength = state.doc.length
  const errorPos = error?.pos ?? null
  let errorClaimed = false

  regions.forEach((region, index) => {
    if (region.to > docLength) return
    const hasError = error !== null && errorPos !== null && errorPos >= region.from && errorPos <= region.to
    if (hasError) errorClaimed = true
    const err = hasError ? error!.message : null
    if (mode === "source") {
      ranges.push(sourceMark.range(region.from, region.to))
      return
    }
    const block = fillsLines(state, region) && (region.kind !== "output" || region.rendered.includes("\n"))
    if (index === active) {
      if (block) {
        const first = state.doc.lineAt(region.from).number
        const last = state.doc.lineAt(region.to).number
        ranges.push(Decoration.widget({ widget: new EditingBar(region.kind === "output" ? "{{ }}" : region.label), block: true, side: -1 }).range(region.from))
        for (let n = first; n <= last; n++) {
          const cls = `cm-liquid-open-line${n === first ? " cm-liquid-open-first" : ""}${n === last ? " cm-liquid-open-last" : ""}${err ? " cm-liquid-open-error" : ""}`
          ranges.push(Decoration.line({ class: cls }).range(state.doc.line(n).from))
        }
        ranges.push(Decoration.widget({ widget: new ResultBar(region.rendered, err), block: true, side: 1 }).range(region.to))
      } else {
        ranges.push((err ? activeErrorMark : activeMark).range(region.from, region.to))
      }
      return
    }
    const opts: WidgetOpts = {
      fresh: fresh.has(index),
      caret: caretFor(state, region),
      error: err,
      note: block ? branchNote(state, region) : null,
      line: String(state.doc.lineAt(region.from).number),
      marks: block ? "" : contextMarks(state, region.from),
    }
    if (block) {
      ranges.push(Decoration.replace({ widget: new BlockWidget(region, opts), block: true }).range(region.from, region.to))
    } else {
      ranges.push(Decoration.replace({ widget: new InlineWidget(region, opts) }).range(region.from, region.to))
    }
  })

  if (error && errorPos !== null && !errorClaimed && errorPos <= docLength) {
    ranges.push(errorLine.range(state.doc.lineAt(errorPos).from))
  }

  // YAML frontmatter: keep it from being drawn as a markdown heading.
  if (state.doc.sliceString(0, 4) === "---\n") {
    const end = state.doc.sliceString(0, Math.min(docLength, 20000)).indexOf("\n---", 3)
    if (end > 0) {
      const last = state.doc.lineAt(end + 1).number
      for (let n = 1; n <= last; n++) {
        ranges.push(Decoration.line({ class: `cm-frontmatter${n === 1 ? " cm-frontmatter-first" : ""}${n === last ? " cm-frontmatter-last" : ""}` }).range(state.doc.line(n).from))
      }
    }
  }
  return Decoration.set(ranges, true)
}

const decorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    const changed =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setRegions) || e.is(setMode) || e.is(setFocused) || e.is(setError))
    return changed ? buildDecorations(tr.state) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

// A floating "renders as" tip above an inline section being edited.
const inlineResultTooltip = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_value, tr) {
    const state = tr.state
    const index = activeRegion(state)
    if (index === -1) return []
    const { regions, error } = state.field(previewState)
    const region = regions[index]
    if (fillsLines(state, region) && (region.kind !== "output" || region.rendered.includes("\n"))) return []
    const err = error && error.pos !== null && error.pos >= region.from && error.pos <= region.to ? error.message : null
    return [
      {
        pos: region.from,
        above: true,
        strictSide: false,
        arrow: false,
        create: () => {
          const dom = document.createElement("div")
          dom.className = "cm-liquid-inline-result" + (err ? " cm-liquid-inline-result-error" : "")
          dom.textContent = err ? `⚠ ${err}` : `→ ${region.rendered === "" ? "(nothing)" : region.rendered}`
          return { dom }
        },
      },
    ]
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
})

// Line numbers: a card shows the range of lines it stands for.
class RangeNumber extends GutterMarker {
  constructor(readonly text: string) {
    super()
  }
  eq(other: RangeNumber) {
    return other.text === this.text
  }
  toDOM() {
    const el = document.createElement("span")
    el.className = "cm-range-number"
    el.textContent = this.text
    return el
  }
}

const cardLineNumbers = lineNumberWidgetMarker.of((view, widget, block) => {
  if (!(widget instanceof BlockWidget)) return null
  const first = view.state.doc.lineAt(block.from).number
  const last = view.state.doc.lineAt(block.to).number
  return new RangeNumber(first === last ? String(first) : `${first}–${last}`)
})

// Change bars: lines that differ from the file on disk.
export const setOriginal = StateEffect.define<string>()

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: "added" | "deleted") {
    super()
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind
  }
  toDOM() {
    const el = document.createElement("div")
    el.className = `cm-change-${this.kind}`
    return el
  }
}
const added = new ChangeMarker("added")
const deleted = new ChangeMarker("deleted")

const changeState = StateField.define<{ original: string | null; markers: RangeSet<GutterMarker> }>({
  create: () => ({ original: null, markers: RangeSet.empty }),
  update(value, tr) {
    let original = value.original
    for (const e of tr.effects) if (e.is(setOriginal)) original = e.value
    if (original === null) return value
    if (!tr.docChanged && original === value.original) return value
    const current = tr.state.doc.toString()
    if (current === original) return { original, markers: RangeSet.empty }
    const marks: Range<GutterMarker>[] = []
    let line = 1
    const lines = tr.state.doc.lines
    for (const part of diffLines(original, current)) {
      const count = part.count ?? part.value.split("\n").length - 1
      if (part.added) {
        for (let i = 0; i < count && line + i <= lines; i++) marks.push(added.range(tr.state.doc.line(line + i).from))
        line += count
      } else if (part.removed) {
        if (line <= lines) marks.push(deleted.range(tr.state.doc.line(line).from))
      } else {
        line += count
      }
    }
    return { original, markers: RangeSet.of(marks, true) }
  },
})

const changeGutter = gutter({
  class: "cm-change-gutter",
  markers: (view) => view.state.field(changeState).markers,
})

// Liquid delimiters anywhere in the text get a colour, so new Liquid that the
// server has not reported yet still stands out.
const liquidSyntax = new MatchDecorator({
  regexp: /\{\{-?[\s\S]*?-?\}\}|\{%-?[\s\S]*?-?%\}/g,
  decoration: Decoration.mark({ class: "cm-liquid-syntax" }),
})

const includeSyntax = new MatchDecorator({
  regexp: /^@[~#a-zA-Z0-9_.${}*?[][\w\-/.:${}*?[\],!~#%+^()]*\.md\S*$/gm,
  decoration: Decoration.mark({ class: "cm-include-line", attributes: { title: "Includes another file. Ctrl+click to open it." } }),
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

// ---- @include lines: where each one points, and the ones the build fails on ----

export type IncludeInfo = { line: number; reference: string; glob: boolean; files: { id?: string; display: string }[]; error?: string }
export const setIncludes = StateEffect.define<IncludeInfo[]>()

class IncludeChip extends WidgetType {
  constructor(
    readonly info: IncludeInfo,
    readonly open: (id: string) => void,
  ) {
    super()
  }
  eq(other: IncludeChip) {
    return JSON.stringify(other.info) === JSON.stringify(this.info)
  }
  toDOM(): HTMLElement {
    const { info } = this
    const el = document.createElement("span")
    el.className = `cm-include-chip${info.error ? " cm-include-chip-error" : ""}`
    if (info.error) {
      el.textContent = `⚠ ${info.error.replace(/^(Matches no files|Not found)\. /, "").split(". ")[0].slice(0, 70)}: the build fails here`
      el.title = info.error
    } else if (info.files.length === 1) {
      el.textContent = `→ ${info.files[0].display.split("/").slice(-2).join("/")}`
      el.title = `Includes ${info.files[0].display}. Click to open it.`
    } else {
      el.textContent = `→ ${info.files.length} files`
      el.title = info.files.map((f) => f.display).join("\n")
    }
    const target = info.files.find((f) => f.id)?.id
    if (target) {
      el.style.cursor = "pointer"
      el.addEventListener("mousedown", (e) => {
        e.preventDefault()
        this.open(target)
      })
    }
    return el
  }
  ignoreEvent() {
    return true
  }
}

const brokenInclude = Decoration.line({ class: "cm-include-broken" })

function includeField(open: (id: string) => void) {
  return StateField.define<{ infos: IncludeInfo[]; deco: DecorationSet }>({
    create: () => ({ infos: [], deco: Decoration.none }),
    update(value, tr) {
      let infos = value.infos
      for (const e of tr.effects) if (e.is(setIncludes)) infos = e.value
      if (infos === value.infos && !tr.docChanged) return value
      const doc = tr.state.doc
      const ranges: Range<Decoration>[] = []
      for (const info of infos) {
        if (info.line > doc.lines) continue
        const line = doc.line(info.line)
        if (!line.text.trim().startsWith("@")) continue
        if (info.error) ranges.push(brokenInclude.range(line.from))
        ranges.push(Decoration.widget({ widget: new IncludeChip(info, open), side: 1 }).range(line.to))
      }
      return { infos, deco: Decoration.set(ranges, true) }
    },
    provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
  })
}

export type PreviewCallbacks = {
  /** Called when the cursor leaves a region, or the editor loses focus. */
  onLeaveRegion: () => void
  /** Called on Ctrl/Cmd+click on an `@include` line, with the line's text. */
  onOpenInclude: (line: string) => void
  /** Opens a workspace file by id. */
  onOpenFile: (id: string) => void
}

export function liquidPreview(callbacks: PreviewCallbacks): Extension {
  return [
    previewState,
    decorations,
    inlineResultTooltip,
    changeState,
    changeGutter,
    includeField(callbacks.onOpenFile),
    cardLineNumbers,
    highlighter(liquidSyntax),
    highlighter(includeSyntax),
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    EditorView.updateListener.of((update) => {
      const before = activeRegion(update.startState)
      const after = activeRegion(update.state)
      if (before !== -1 && before !== after) callbacks.onLeaveRegion()
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false
        const target = event.target as HTMLElement
        if (!target.closest(".cm-include-line")) return false
        const pos = view.posAtDOM(target)
        callbacks.onOpenInclude(view.state.doc.lineAt(pos).text.trim())
        event.preventDefault()
        return true
      },
    }),
    Prec.high(
      keymap.of([
        {
          // Jump to the next / previous Liquid section and open it.
          key: "Alt-ArrowDown",
          run(view) {
            const { regions } = view.state.field(previewState)
            const pos = view.state.selection.main.head
            const next = regions.find((r) => r.from > pos)
            if (!next) return false
            view.dispatch({ selection: { anchor: caretFor(view.state, next) }, scrollIntoView: true })
            return true
          },
        },
        {
          key: "Alt-ArrowUp",
          run(view) {
            const { regions } = view.state.field(previewState)
            const pos = view.state.selection.main.head
            const prev = [...regions].reverse().find((r) => r.to < pos)
            if (!prev) return false
            view.dispatch({ selection: { anchor: caretFor(view.state, prev) }, scrollIntoView: true })
            return true
          },
        },
        {
          key: "Escape",
          run(view) {
            if (completionStatus(view.state)) return false
            const index = activeRegion(view.state)
            if (index === -1) return false
            const region = view.state.field(previewState).regions[index]
            view.dispatch({ selection: { anchor: Math.min(region.to, view.state.doc.length) } })
            return true
          },
        },
      ]),
    ),
  ]
}
