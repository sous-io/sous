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
}

export const SEED_PROPOSALS: Proposal[] = [
  {
    id: "seed-1",
    repo: "github.com/sous-io/sous-recipes",
    number: 212,
    title: "workflow/task-files: say where the archive folder lives",
    branch: "sous/edit-2026-10-20-0912",
    recipes: [{ name: "workflow/task-files", from: "1.1.0", to: "1.1.1" }],
    files: 2,
    stage: "review",
    openedAt: "3 days ago",
    draft: false,
  },
  {
    id: "seed-2",
    repo: "github.com/sous-io/sous-recipes",
    number: 207,
    title: "communication/control-flow: add /opine examples",
    branch: "sous/edit-2026-10-14-1630",
    recipes: [{ name: "communication/control-flow", from: "1.2.0", to: "1.2.1" }],
    files: 1,
    stage: "released",
    openedAt: "9 days ago",
    draft: false,
  },
]

/** Recipes that have a newer release than the one this project pins (mock). */
export const MOCK_UPDATES: Record<string, string> = {
  "workflow/github-projects": "1.4.0",
  "core/sous-skills": "0.2.35",
}

export function bump(version: string, kind: "patch" | "minor" | "major"): string {
  const [major, minor, patch] = version.split(".").map((n) => Number.parseInt(n, 10) || 0)
  if (kind === "major") return `${major + 1}.0.0`
  if (kind === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function contributionBranch(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `sous/edit-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
