// Questions a running command asks (sous's prompter, in the browser): one dialog at a time, in
// the order they were asked. Declining fails the question in the command, as Ctrl+C would.

import { useEffect, useState, useSyncExternalStore } from "react"
import { MessageCircleQuestionIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { sous, type PendingQuestion } from "@/lib/socket"
import { cn } from "@/lib/utils"

let snapshot: PendingQuestion | undefined
const subscribe = (notify: () => void) =>
  sous.on("question", () => {
    snapshot = sous.questions.values().next().value
    notify()
  })

export function Questions() {
  const current = useSyncExternalStore(subscribe, () => snapshot)
  const [text, setText] = useState("")
  const [choice, setChoice] = useState(0)

  useEffect(() => {
    if (!current) return
    const q = current.question
    setText(q.kind === "value" ? (q.default ?? "") : "")
    setChoice(q.kind === "choice" ? (q.defaultIndex ?? 0) : 0)
  }, [current])

  if (!current) return null
  const q = current.question
  const answer = (value: unknown) => sous.answer(current, value)

  return (
    <Dialog open onOpenChange={(open) => !open && sous.answer(current, undefined, true)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestionIcon className="size-4 text-brand" /> {q.message}
          </DialogTitle>
          <DialogDescription>
            <code className="font-mono text-xs">sous {current.intent.replace(/\./g, " ")}</code> is asking. Closing this declines the question.
          </DialogDescription>
        </DialogHeader>
        {q.kind === "value" && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              answer(text)
            }}
            className="flex gap-2"
          >
            <Input autoFocus type={q.secret ? "password" : "text"} value={text} onChange={(e) => setText(e.target.value)} />
            <Button type="submit">Answer</Button>
          </form>
        )}
        {q.kind === "confirm" && (
          <div className="flex justify-end gap-2">
            {/* Enter answers with the question's own default; with none, it answers No, the safe side. */}
            <Button variant={q.default === true ? "outline" : "default"} autoFocus={q.default !== true} onClick={() => answer(false)}>
              No
            </Button>
            <Button variant={q.default === true ? "default" : "outline"} autoFocus={q.default === true} onClick={() => answer(true)}>
              Yes
            </Button>
          </div>
        )}
        {q.kind === "choice" && (
          <div className="space-y-1.5">
            {q.choices.map((option, i) => (
              <button
                key={i}
                onClick={() => setChoice(i)}
                onDoubleClick={() => answer(i)}
                className={cn("block w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted", choice === i && "border-brand bg-brand/8")}
              >
                <div className="font-medium">{option.label}</div>
                {option.description && <div className="text-xs text-muted-foreground">{option.description}</div>}
              </button>
            ))}
            <div className="flex justify-end pt-1">
              <Button onClick={() => answer(choice)}>Choose</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
