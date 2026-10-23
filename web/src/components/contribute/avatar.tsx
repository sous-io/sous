import { useState } from "react"
import { cn } from "@/lib/utils"

export function RepoAvatar({ owner, className }: { owner?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!owner || failed)
    return (
      <span className={cn("grid place-items-center rounded-lg bg-recipe/15 font-semibold text-recipe", className)}>
        {(owner ?? "?").slice(0, 1).toUpperCase()}
      </span>
    )
  return (
    <img
      src={`https://github.com/${owner}.png?size=96`}
      alt=""
      onError={() => setFailed(true)}
      className={cn("rounded-lg bg-muted object-cover ring-1 ring-border", className)}
    />
  )
}

