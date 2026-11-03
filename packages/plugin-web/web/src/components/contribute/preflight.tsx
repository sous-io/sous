import { useEffect, useState, type ReactNode } from "react"
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, InfoIcon, LoaderIcon, OctagonXIcon } from "lucide-react"
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

/**
 * A checklist that fills in one row at a time, the way a real preflight would.
 * When everything passes it folds to one line, so the change itself comes first;
 * it opens by itself when something fails or needs a look.
 */
export function Preflight({ checks, loading }: { checks: Check[]; loading: boolean }) {
  const [shown, setShown] = useState(0)
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    if (loading) return
    if (shown >= checks.length) return
    const t = window.setTimeout(() => setShown((n) => n + 1), shown === 0 ? 60 : 70)
    return () => window.clearTimeout(t)
  }, [loading, shown, checks.length])

  const stops = checks.filter((c) => c.state === "stop").length
  const warns = checks.filter((c) => c.state === "warn").length
  const passed = checks.filter((c) => c.state === "ok" || c.state === "info").length
  const allShown = !loading && shown >= checks.length
  const expanded = open ?? (allShown && (stops > 0 || warns > 0))

  const summary = !allShown ? (
    <>
      <span className="grid size-4.5 place-items-center rounded-full border">{ICON.wait}</span>
      <span className="text-[13px] text-muted-foreground">
        Checking{checks.length ? ` ${Math.min(shown, checks.length)} of ${checks.length}` : ""}…
      </span>
    </>
  ) : stops ? (
    <>
      <span className="grid size-4.5 place-items-center rounded-full bg-destructive/12">{ICON.stop}</span>
      <span className="text-[13px] font-medium text-destructive">
        {stops} thing{stops === 1 ? "" : "s"} to fix first
      </span>
    </>
  ) : warns ? (
    <>
      <span className="grid size-4.5 place-items-center rounded-full bg-warning/15">{ICON.warn}</span>
      <span className="text-[13px] font-medium">
        Ready, with {warns} thing{warns === 1 ? "" : "s"} to look at
      </span>
    </>
  ) : (
    <>
      <span className="grid size-4.5 place-items-center rounded-full bg-success">{ICON.ok}</span>
      <span className="text-[13px] font-medium">Ready to propose</span>
    </>
  )

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", allShown && stops > 0 && "border-destructive/40")}>
      <button
        onClick={() => setOpen(!expanded)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
        aria-expanded={expanded}
      >
        {summary}
        {allShown && (
          <span className="text-xs text-muted-foreground">
            · {passed} of {checks.length} checks passed
          </span>
        )}
        <ChevronRightIcon className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <ul className="divide-y border-t">
          {checks.map((c, i) => {
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
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
