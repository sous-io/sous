// MOCK DATA. Everything here is invented to show what the GUI could do.

export type ProposalStage = "opened" | "checks" | "review" | "merged" | "released"

export type Proposal = {
  id: string
  repo: string
  number: number
  title: string
  branch: string
  recipes: { name: string; from: string; to: string }[]
  files: number
  stage: ProposalStage
  openedAt: string
  draft: boolean
  /** Seeded on first load to show what the page can do; not made by you. */
  example?: boolean
  /** "core" when the edit was routed to sous-io/sous by the recipe's `submissions` policy. */
  kind?: "recipe" | "core"
  /** Where it was pushed from: your fork, or the repository itself. */
  head?: string
  /** A review comment or other news on the proposal. */
  note?: { who: string; text: string; tone: "info" | "warning" }
  /** The file ids it carries, so "Add changes" can open them again. */
  fileIds?: string[]
  /** The user picked "keep my edits on this machine" until the release. */
  keptLocal?: boolean
  /** The project was moved to the released version. */
  updated?: boolean
  description?: string
}

export const SEED_PROPOSALS: Proposal[] = [
  {
    id: "seed-1",
    repo: "github.com/sous-io/sous-recipes",
    number: 212,
    title: "workflow/task-files: say where the archive folder lives",
    branch: "sous/edit-20261020-0912",
    recipes: [{ name: "workflow/task-files", from: "1.1.0", to: "1.1.1" }],
    files: 2,
    stage: "review",
    openedAt: "3 days ago",
    draft: false,
    example: true,
    kind: "recipe",
    head: "sous-io/sous-recipes",
    note: { who: "maintainer", text: "Looks good. Could the archive line use {{ taskFileRoot }} instead of a fixed path?", tone: "warning" },
  },
  {
    id: "seed-2",
    repo: "github.com/sous-io/sous-recipes",
    number: 207,
    title: "communication/control-flow: add /opine examples",
    branch: "sous/edit-20261014-1630",
    recipes: [{ name: "communication/control-flow", from: "1.2.0", to: "1.2.1" }],
    files: 1,
    stage: "released",
    openedAt: "9 days ago",
    draft: false,
    example: true,
    kind: "recipe",
    head: "sous-io/sous-recipes",
  },
]

/** Recipes that have a newer release than the one this project pins (mock). */
export const MOCK_UPDATES: Record<string, string> = {
  "workflow/github-projects": "1.4.0",
  "core/sous-skills": "0.2.35",
}

export type BumpKind = "patch" | "minor" | "major"

export function bump(version: string, kind: BumpKind): string {
  const [major, minor, patch] = version.split(".").map((n) => Number.parseInt(n, 10) || 0)
  if (kind === "major") return `${major + 1}.0.0`
  if (kind === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The branch name `sous repo contribute` generates: sous/edit-YYYYMMDD-HHMM. */
export function contributionBranch(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `sous/edit-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
