// Every message on the socket to sous, newest last: for seeing what the editor asks sous, and
// what comes back. Opened with Ctrl+` or from the command palette. The token is never shown.

import { useEffect, useState, useSyncExternalStore } from "react"
import { create } from "zustand"
import { ArrowDownLeftIcon, ArrowUpRightIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sous } from "@/lib/socket"
import { cn } from "@/lib/utils"

export const useSocketDebug = create<{ open: boolean; toggle: () => void }>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
}))

let version = 0
const subscribe = (notify: () => void) =>
  sous.on("log", () => {
    version++
    notify()
  })

function summary(message: { type: string } & Record<string, unknown>): string {
  switch (message.type) {
    case "run":
      return `${String(message.intent)} ${JSON.stringify(message.input).slice(0, 160)}`
    case "result":
      return message.ok ? `ok in ${String(message.ms)} ms, ${JSON.stringify(message.data).length.toLocaleString()} bytes` : `failed: ${(message.error as { message: string }).message}`
    case "report":
      return `${String(message.level)}: ${String(message.message)}`
    case "event":
      return String(message.name)
    case "ready":
      return `${(message.intents as unknown[]).length} intents`
    default:
      return JSON.stringify(message).slice(0, 160)
  }
}

export function SocketDebug() {
  const open = useSocketDebug((s) => s.open)
  const toggle = useSocketDebug((s) => s.toggle)
  useSyncExternalStore(subscribe, () => version)
  const [filter, setFilter] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  if (!open) return null
  const rows = sous.log.filter((entry) => !filter || JSON.stringify(entry.message).toLowerCase().includes(filter.toLowerCase())).slice(-300)

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex h-72 flex-col border-t bg-popover shadow-2xl">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <b>Socket</b>
        <span className="text-muted-foreground">
          {sous.state} · {sous.log.length} messages
        </span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="ml-3 h-6 w-56 rounded border bg-background px-2" />
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={toggle} aria-label="Close">
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[18px]">
        {rows.map((entry, i) => {
          const message = entry.message as { type: string; id?: number } & Record<string, unknown>
          return (
            <div key={i} className={cn("flex gap-2 px-3 hover:bg-muted/60", message.type === "result" && message.ok === false && "text-destructive")} title={JSON.stringify(message, null, 2).slice(0, 4000)}>
              <span className="w-16 shrink-0 text-muted-foreground">{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</span>
              {entry.direction === "out" ? <ArrowUpRightIcon className="mt-0.5 size-3 shrink-0 text-brand" /> : <ArrowDownLeftIcon className="mt-0.5 size-3 shrink-0 text-success" />}
              <span className="w-12 shrink-0">{message.type}</span>
              <span className="w-8 shrink-0 text-muted-foreground">{message.id ?? ""}</span>
              <span className="truncate">{summary(message)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
