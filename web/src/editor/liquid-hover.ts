// Hover a variable inside Liquid to see its value and where that value comes from.

import { hoverTooltip } from "@codemirror/view"
import type { VarFact } from "@/lib/api"

export function variableHover(getVars: () => Record<string, string>, getFacts: () => Record<string, VarFact>) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const text = line.text
    const at = pos - line.from
    // Only inside {{ … }} or {% … %}.
    const before = text.slice(0, at)
    const open = Math.max(before.lastIndexOf("{{"), before.lastIndexOf("{%"))
    const close = Math.max(before.lastIndexOf("}}"), before.lastIndexOf("%}"))
    if (open === -1 || close > open) return null
    let start = at
    let end = at
    while (start > 0 && /[\w]/.test(text[start - 1])) start--
    while (end < text.length && /[\w]/.test(text[end])) end++
    const name = text.slice(start, end)
    const vars = getVars()
    if (!name || !(name in vars)) return null
    const fact = getFacts()[name]
    return {
      pos: line.from + start,
      end: line.from + end,
      above: true,
      create: () => {
        const dom = document.createElement("div")
        dom.className = "cm-var-hover"
        const head = document.createElement("div")
        head.className = "cm-var-hover-name"
        head.textContent = name
        const value = document.createElement("div")
        value.className = "cm-var-hover-value"
        value.textContent = vars[name] === "" ? "(empty)" : vars[name]
        dom.append(head, value)
        if (fact?.answeredBy || fact?.recipe) {
          const from = document.createElement("div")
          from.className = "cm-var-hover-from"
          from.textContent = [fact.recipe ? `asked for by ${fact.recipe}` : null, fact.answeredBy ? `set in ${fact.answeredBy}` : null]
            .filter(Boolean)
            .join(" · ")
          dom.append(from)
        }
        if (fact?.description) {
          const desc = document.createElement("div")
          desc.className = "cm-var-hover-desc"
          desc.textContent = fact.description.length > 220 ? fact.description.slice(0, 220) + "…" : fact.description
          dom.append(desc)
        }
        return { dom }
      },
    }
  })
}
