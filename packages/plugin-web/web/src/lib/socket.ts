// The one connection to sous: a WebSocket that runs intents, streams what they report, carries
// their questions, and hears about files changing. It reconnects on its own when sous restarts or
// the laptop wakes up. The messages are defined once, in the plugin's src/protocol.ts.

import type { AskMessage, ClientMessage, EventMessage, IntentSummary, Question, ReadyMessage, ReportMessage, ServerMessage } from "@protocol"

export type { IntentSummary, Question, ReportMessage }

export type RunOptions = {
  /** Every message the run reports, as it arrives. */
  onReport?: (report: ReportMessage) => void
  /** Aborting it sends `cancel`. */
  signal?: AbortSignal
  /** Settings for a "what if" config the run uses instead of the real one (read-only intents only). */
  preview?: { path: string[]; value: unknown }[]
}

export class RunError extends Error {
  readonly kind?: string
  readonly details?: string[]
  readonly cancelled: boolean

  constructor(message: string, kind?: string, details?: string[], cancelled = false) {
    super(message)
    this.kind = kind
    this.details = details
    this.cancelled = cancelled
  }
}

export type ConnectionState = "connecting" | "open" | "closed" | "unauthorized"

/** A question a run asks, waiting for the person to answer it. */
export type PendingQuestion = { run: number; intent: string; ask: number; question: Question }

/** One socket message, kept for the debug panel. */
export type LoggedMessage = { at: number; direction: "in" | "out"; message: ClientMessage | ServerMessage }

type Pending = {
  intent: string
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  onReport?: (report: ReportMessage) => void
}

/** The token sous put in the URL fragment (#token=...), kept for this tab, then removed from the address bar. */
function readToken(): string {
  const match = /^#token=([0-9a-f]+)/.exec(window.location.hash)
  try {
    if (match) {
      sessionStorage.setItem("sous-token", match[1])
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`)
      return match[1]
    }
    return sessionStorage.getItem("sous-token") ?? ""
  } catch {
    return match?.[1] ?? ""
  }
}

class SousSocket {
  private socket: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private queue: ClientMessage[] = []
  private retry = 0
  private readonly token = readToken()
  private readyWaiters: ((ready: ReadyMessage) => void)[] = []

  ready: ReadyMessage | null = null
  state: ConnectionState = "connecting"
  readonly log: LoggedMessage[] = []
  readonly questions = new Map<string, PendingQuestion>()
  private readonly listeners = {
    state: new Set<(state: ConnectionState) => void>(),
    event: new Set<(event: EventMessage) => void>(),
    question: new Set<() => void>(),
    log: new Set<() => void>(),
  }

  constructor() {
    this.connect()
  }

  /** Runs an intent and resolves with its result data (`IntentOutputs.toPlain()`). */
  run<T = unknown>(intent: string, input?: unknown, options: RunOptions = {}): Promise<T> {
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new RunError("Cancelled.", "cancelled", undefined, true))
        return
      }
      this.pending.set(id, { intent, resolve: resolve as (data: unknown) => void, reject, onReport: options.onReport })
      options.signal?.addEventListener("abort", () => this.send({ type: "cancel", id }), { once: true })
      this.send({ type: "run", id, intent, input: input ?? {}, ...(options.preview ? { preview: options.preview } : {}) })
    })
  }

  /** Answers a question a run asked. */
  answer(question: PendingQuestion, value: unknown, cancelled = false): void {
    this.questions.delete(`${question.run}:${question.ask}`)
    this.emit("question")
    this.send({ type: "answer", id: question.run, ask: question.ask, value, cancelled })
  }

  whenReady(): Promise<ReadyMessage> {
    return this.ready ? Promise.resolve(this.ready) : new Promise((resolve) => this.readyWaiters.push(resolve))
  }

  on(kind: "state", listener: (state: ConnectionState) => void): () => void
  on(kind: "event", listener: (event: EventMessage) => void): () => void
  on(kind: "question" | "log", listener: () => void): () => void
  on(kind: keyof SousSocket["listeners"], listener: (arg: never) => void): () => void {
    const set = this.listeners[kind] as Set<typeof listener>
    set.add(listener)
    return () => set.delete(listener)
  }

  private emit(kind: "question" | "log"): void
  private emit(kind: "state", arg: ConnectionState): void
  private emit(kind: "event", arg: EventMessage): void
  private emit(kind: keyof SousSocket["listeners"], arg?: unknown): void {
    for (const listener of this.listeners[kind] as Set<(arg: unknown) => void>) listener(arg)
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.emit("state", state)
  }

  private record(direction: "in" | "out", message: ClientMessage | ServerMessage): void {
    // The token never goes into the log.
    const shown = message.type === "hello" ? { ...message, token: "••••••" } : message
    this.log.push({ at: Date.now(), direction, message: shown })
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500)
    this.emit("log")
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN && (this.ready || message.type === "hello")) {
      this.record("out", message)
      this.socket.send(JSON.stringify(message))
    } else {
      this.queue.push(message)
    }
  }

  private connect(): void {
    const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
    const socket = new WebSocket(url)
    this.socket = socket
    this.setState("connecting")

    socket.onopen = () => {
      this.retry = 0
      this.send({ type: "hello", token: this.token })
    }
    socket.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage)
    socket.onclose = (event) => {
      this.ready = null
      // Runs in flight are lost with the connection; their callers hear so.
      for (const [id, pending] of this.pending) {
        pending.reject(new RunError("The connection to sous closed before the command finished.", "disconnected"))
        this.pending.delete(id)
      }
      this.questions.clear()
      this.emit("question")
      if (event.code === 4401) {
        this.setState("unauthorized")
        return
      }
      this.setState("closed")
      const delay = Math.min(10_000, 250 * 2 ** this.retry++)
      window.setTimeout(() => this.connect(), delay)
    }
  }

  private receive(message: ServerMessage): void {
    this.record("in", message)
    switch (message.type) {
      case "ready": {
        this.ready = message
        this.setState("open")
        for (const waiter of this.readyWaiters.splice(0)) waiter(message)
        const queued = this.queue.splice(0)
        for (const item of queued) this.send(item)
        break
      }
      case "report":
        this.pending.get(message.id)?.onReport?.(message)
        break
      case "ask": {
        const pending = this.pending.get(message.id)
        const ask: AskMessage = message
        this.questions.set(`${ask.id}:${ask.ask}`, { run: ask.id, intent: pending?.intent ?? "", ask: ask.ask, question: ask.question })
        this.emit("question")
        break
      }
      case "result": {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (!pending) break
        if (message.ok) pending.resolve(message.data)
        else pending.reject(new RunError(message.error.message, message.error.kind, message.error.details, message.error.cancelled === true))
        break
      }
      case "event":
        this.emit("event", message)
        break
    }
  }
}

/** The tab's connection to sous. */
export const sous = new SousSocket()
