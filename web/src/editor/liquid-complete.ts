// Autocomplete inside Liquid: variables (with their values) after `{{ `,
// tags after `{% `, and filters after `| `.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import type { Extension } from "@codemirror/state"

const TAGS: [string, string][] = [
  ["if", "{% if condition %} … {% endif %}"],
  ["unless", "{% unless condition %} … {% endunless %}"],
  ["elsif", "Another branch of an if"],
  ["else", "The branch when nothing above matched"],
  ["case", "{% case x %}{% when 'a' %} … {% endcase %}"],
  ["when", "A branch of a case"],
  ["for", "{% for item in list %} … {% endfor %}"],
  ["assign", "{% assign name = value %}"],
  ["capture", "{% capture name %} … {% endcapture %}"],
  ["render", "{% render \"path/to/partial.md\" %}: sous resolves @aliases, #names and ~recipes"],
  ["raw", "{% raw %} … {% endraw %}: print Liquid without running it"],
  ["comment", "{% comment %} … {% endcomment %}"],
  ["listFiles", "sous: glob files and print a bullet list. root=\"…\" include=\"…\" exclude=\"…\" relative=\"true\""],
  ["getFiles", "sous: glob files into a variable for a for loop. {% getFiles files root=\"…\" include=\"…\" %}"],
  ["showVars", "sous: dump every variable in scope as JSON (secrets hidden)"],
  ["exportScalarVarsJs", "sous: print scalar variables as `export default {…}`"],
]

const FILTERS: [string, string][] = [
  ["bulletList", "sous: an array as a markdown bullet list"],
  ["upcase", "UPPER CASE"],
  ["downcase", "lower case"],
  ["capitalize", "First letter upper case"],
  ["default", "default: \"fallback\" when empty"],
  ["split", "split: \",\" → array"],
  ["join", "join: \", \""],
  ["first", "First item"],
  ["last", "Last item"],
  ["size", "Length"],
  ["replace", "replace: \"a\", \"b\""],
  ["append", "append: \"text\""],
  ["prepend", "prepend: \"text\""],
  ["strip", "Trim whitespace"],
  ["sort", "Sort an array"],
  ["uniq", "Remove duplicates"],
  ["where", "where: \"key\", \"value\""],
  ["map", "map: \"key\""],
  ["date", "date: \"%Y-%m-%d\""],
  ["escape", "HTML-escape"],
  ["slugify", "a-slug-like-this"],
  ["json", "As JSON"],
]

export function liquidCompletion(getVars: () => Record<string, string>): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    const openOut = before.lastIndexOf("{{")
    const openTag = before.lastIndexOf("{%")
    const closeOut = before.lastIndexOf("}}")
    const closeTag = before.lastIndexOf("%}")
    const inOut = openOut > closeOut
    const inTag = openTag > closeTag
    if (!inOut && !inTag) return null
    const word = context.matchBefore(/[\w.]*/)
    if (!word) return null
    const start = Math.max(openOut, openTag) + 2
    const inside = before.slice(start, word.from - line.from)

    // After a pipe: filters.
    if (/\|\s*$/.test(inside)) {
      return {
        from: word.from,
        options: FILTERS.map(([label, info]) => ({ label, type: "function", info, boost: label === "bulletList" ? 2 : 0 })),
      }
    }
    // First word of a tag: tag names.
    if (inTag && /^-?\s*$/.test(inside)) {
      return { from: word.from, options: TAGS.map(([label, info]) => ({ label, type: "keyword", info, boost: label.match(/^[a-z]+Files|showVars/) ? 1 : 0 })) }
    }
    // Otherwise: variables, with their values.
    const vars = getVars()
    const options: Completion[] = Object.entries(vars).map(([label, value]) => ({
      label,
      type: "variable",
      detail: value === "" ? "(empty)" : value.length > 40 ? value.slice(0, 40) + "…" : value,
      info: value === "••••••" ? "A secret: its value is hidden." : `Value in this project: ${value === "" ? "(empty)" : value}`,
    }))
    if (!word.text && !context.explicit && !/\s$/.test(inside) && inside !== "") return null
    return { from: word.from, options, validFor: /^[\w]*$/ }
  }
  return autocompletion({ override: [source], icons: true, activateOnTyping: true })
}
