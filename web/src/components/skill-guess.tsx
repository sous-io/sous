// "Which skill would load?": ranks the skill menu against a request by word
// overlap with each skill's name and description. A rough guess, labelled as
// one; the real choice is the model's. Useful for spotting descriptions that
// don't mention the words people actually use.

import { useMemo, useState } from "react"
import { SearchIcon, SparklesIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import type { OutputInfo } from "@/lib/api"

const STOP = new Set("a an the and or to of for in on with this that it is are be when you your i me my we our use using how what do does can should".split(" "))

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
}

export function SkillGuess({ skills, onOpen }: { skills: OutputInfo[]; onOpen: (o: OutputInfo) => void }) {
  const [q, setQ] = useState("")
  const ranked = useMemo(() => {
    const ask = words(q)
    if (ask.length === 0) return []
    const docs = skills.map((s) => ({ s, w: words(`${s.skillName ?? ""} ${s.skillName ?? ""} ${s.description ?? ""}`) }))
    const df = new Map<string, number>()
    for (const d of docs) for (const w of new Set(d.w)) df.set(w, (df.get(w) ?? 0) + 1)
    return docs
      .map(({ s, w }) => {
        const set = new Set(w)
        const hits = ask.filter((a) => set.has(a))
        const score = hits.reduce((n, a) => n + Math.log(1 + docs.length / (df.get(a) ?? 1)), 0)
        return { s, score, hits: [...new Set(hits)] }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
  }, [q, skills])
  const top = ranked[0]?.score ?? 1

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <SparklesIcon className="size-4 text-liquid" /> Which skill would load?
        <span className="font-normal text-muted-foreground">Type a request; skills are ranked by the words their descriptions share with it.</span>
      </div>
      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. write unit tests for the parser, or open an issue for this bug" className="pl-8" />
      </div>
      {q && (
        <div className="mt-3 space-y-1.5">
          {ranked.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skill description shares a word with that. Claude would likely load none, so a skill meant for this needs those words in its description.</p>
          ) : (
            ranked.map(({ s, score, hits }) => (
              <button key={s.output} onClick={() => onOpen(s)} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent">
                <span className="w-56 truncate font-mono text-[13px] font-semibold">/{s.skillName}</span>
                <span className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-liquid" style={{ width: `${(score / top) * 100}%` }} />
                </span>
                <span className="truncate text-xs text-muted-foreground">matches {hits.join(", ")}</span>
              </button>
            ))
          )}
          <p className="pt-1 text-[11px] text-muted-foreground">A rough guess by shared words. Claude decides by reading the descriptions, so treat this as a hint about wording, not a prediction.</p>
        </div>
      )}
    </div>
  )
}
