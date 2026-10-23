import { useEffect, useState, type ReactNode } from "react"
import { AlertTriangleIcon, CheckIcon, InfoIcon, LoaderIcon, OctagonXIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type Check = {
  key: string
  state: "ok" | "warn" | "stop" | "wait" | "info"
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
  /** Real, or a statement about what sous will do (shown dimmer). */
  source?: string
}

const ICON = {
  ok: <CheckIcon className="size-3 text-white" strokeWidth={3} />,
  warn: <AlertTriangleIcon className="size-3 text-warning" />,
  stop: <OctagonXIcon className="size-3.5 text-destructive" />,
  wait: <LoaderIcon className="size-3 animate-spin text-muted-foreground" />,
  info: <InfoIcon className="size-3 text-muted-foreground" />,
}

/** A checklist that fills in one row at a time, the way a real preflight would. */
export function Preflight({ checks, loading }: { checks: Check[]; loading: boolean }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (loading) return
    if (shown >= checks.length) return
    const t = window.setTimeout(() => setShown((n) => n + 1), shown === 0 ? 60 : 110)
    return () => window.clearTimeout(t)
  }, [loading, shown, checks.length])

  const stops = checks.filter((c) => c.state === "stop").length
  const warns = checks.filter((c) => c.state === "warn").length
  const allShown = !loading && shown >= checks.length

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <span className="text-[13px] font-semibold">Before you propose</span>
        <span className="text-xs text-muted-foreground">
          {loading
            ? "checking…"
            : !allShown
              ? "checking…"
              : stops
                ? `${stops} thing${stops === 1 ? "" : "s"} to fix first`
                : warns
                  ? `ready, with ${warns} thing${warns === 1 ? "" : "s"} to look at`
                  : "all good"}
        </span>
        {allShown && !stops && !warns && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success">
            <CheckIcon className="size-3" strokeWidth={3} /> {checks.length} checks passed
          </span>
        )}
      </div>
      <ul className="divide-y">
        {loading && checks.length === 0
          ? [0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="grid size-4.5 place-items-center rounded-full border">{ICON.wait}</span>
                <span className="h-3 w-56 animate-pulse rounded bg-muted" style={{ width: `${40 + i * 12}%` }} />
              </li>
            ))
          : checks.map((c, i) => {
              const visible = i < shown
              const state = visible ? c.state : "wait"
              return (
                <li key={c.key} className={cn("flex items-start gap-3 px-4 py-2.5 transition-colors", state === "stop" && "bg-destructive/5")}>
                  <span
                    className={cn(
                      "mt-px grid size-4.5 shrink-0 place-items-center rounded-full transition-all duration-300",
                      state === "ok" && "scale-100 bg-success",
                      state === "warn" && "bg-warning/15",
                      state === "stop" && "bg-destructive/12",
                      (state === "wait" || state === "info") && "border",
                    )}
                  >
                    {ICON[state]}
                  </span>
                  <div className={cn("min-w-0 flex-1 transition-opacity duration-300", !visible && "opacity-40")}>
                    <div className="text-[13px] leading-5">{c.title}</div>
                    {visible && c.detail && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{c.detail}</div>}
                  </div>
                  {visible && c.action && <div className="shrink-0">{c.action}</div>}
                  {visible && c.source && (
                    <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/70">{c.source}</span>
                  )}
                </li>
              )
            })}
      </ul>
    </div>
  )
}
