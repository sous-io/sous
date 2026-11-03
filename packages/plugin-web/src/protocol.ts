/**
 * The messages the browser and `sous serve` exchange over the WebSocket, as JSON. The browser
 * imports this file too (web/src/lib/socket.ts), so both sides share one definition.
 *
 * A run is one chain: the browser sends `run`, sous answers with any number of `report` and `ask`
 * messages tagged with the run's id, then one `result`. `cancel` aborts the chain
 * (`ctx.signal`). `event` messages belong to no run.
 *
 * ```jsonc
 * // browser → sous
 * { "type": "run", "id": 7, "intent": "recipe.update", "input": {} }
 * // sous → browser
 * { "type": "report", "id": 7, "level": "info", "message": "Checking 4 recipes", "style": "plain" }
 * { "type": "ask", "id": 7, "ask": 1, "question": { "kind": "confirm", "message": "Apply 3 updates?" } }
 * // browser → sous
 * { "type": "answer", "id": 7, "ask": 1, "value": true }
 * // sous → browser
 * { "type": "result", "id": 7, "ok": true, "data": { ... } }
 * ```
 */

/** A value set in a "what if" config, as a path into the config and its value. */
export interface PreviewSetting {
    path: string[];
    value: unknown;
}

/** The first message on a socket: the token from the page's URL fragment. */
export interface HelloMessage {
    type: "hello";
    token: string;
}

/** Runs an intent as a chain. With `preview`, against a what-if config with those settings (read-only intents only). */
export interface RunMessage {
    type: "run";
    id: number;
    intent: string;
    input?: unknown;
    preview?: PreviewSetting[];
}

/** The answer to an `ask`. `cancelled` declines it, which fails the question in the chain. */
export interface AnswerMessage {
    type: "answer";
    id: number;
    ask: number;
    value?: unknown;
    cancelled?: boolean;
}

/** Cancels a run. */
export interface CancelMessage {
    type: "cancel";
    id: number;
}

export type ClientMessage = HelloMessage | RunMessage | AnswerMessage | CancelMessage;

/** Who is being served, and every intent the browser can run. Sent after a good `hello`. */
export interface ReadyMessage {
    type: "ready";
    project: { name: string; root: string } | null;
    sous: { version: string };
    intents: IntentSummary[];
}

export interface IntentSummary {
    intent: string;
    plugin: string;
    summary?: string;
    readOnly: boolean | "depends";
    internal: boolean;
    background: boolean;
    /** The intent's input JSON schema, for building a form. */
    input?: unknown;
}

/** A message a running chain reported, as the MCP server sends it. */
export interface ReportMessage {
    type: "report";
    id: number;
    level: string;
    message: string;
    style: string;
    data?: Record<string, unknown>;
}

export type Question =
    | { kind: "value"; message: string; default?: string; secret?: boolean }
    | { kind: "choice"; message: string; choices: Array<{ label: string; description?: string }>; defaultIndex?: number }
    | { kind: "confirm"; message: string; default?: boolean };

/** A question a running chain asks. A choice is answered with the chosen index. */
export interface AskMessage {
    type: "ask";
    id: number;
    ask: number;
    question: Question;
}

export interface ResultOk {
    type: "result";
    id: number;
    ok: true;
    /** `IntentOutputs.toPlain()`. */
    data: unknown;
    ms: number;
}

export interface ResultError {
    type: "result";
    id: number;
    ok: false;
    error: { message: string; kind?: string; details?: string[]; cancelled?: boolean };
    ms: number;
}

/** Something happened outside any run: files changed, the config was rebuilt. */
export interface EventMessage {
    type: "event";
    name: "files.changed" | "config.changed";
    data: unknown;
}

export type ServerMessage = ReadyMessage | ReportMessage | AskMessage | ResultOk | ResultError | EventMessage;
