// The only remote repositories a scenario may write to (push a branch, open a pull request or a
// merge request). Reading any public repository is fine; writing is limited to these four.
// Every remote-writing step calls `assertWritable`, and the pre-push hook in e2e/hooks checks
// every push git itself makes, so a mistake in a scenario fails loudly instead of reaching
// another repository.

export const WRITABLE_REPOSITORIES = [
  { host: "github.com", path: "sous-io/public-github-test-repo" },
  { host: "github.com", path: "sous-io/private-github-test-repo" },
  { host: "gitlab.com", path: "sous-io/public-gitlab-test-repo" },
  { host: "gitlab.com", path: "sous-io/test-repo" },
];

// Reads the host and the repository path out of an https URL, an scp-style SSH remote or an
// ssh:// URL. Returns null when the text is none of those.
export function parseRemote(remote) {
  const text = String(remote).trim();
  let match = text.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (!match) match = text.match(/^(?:[^@/]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { host: match[1].toLowerCase(), path: match[2].toLowerCase() };
}

export function isWritable(remote) {
  const parsed = parseRemote(remote);
  if (!parsed) return false;
  return WRITABLE_REPOSITORIES.some(
    (entry) => entry.host === parsed.host && entry.path.toLowerCase() === parsed.path,
  );
}

export function assertWritable(remote) {
  if (!isWritable(remote)) {
    const allowed = WRITABLE_REPOSITORIES.map((e) => `${e.host}/${e.path}`).join(", ");
    throw new Error(
      `SAFETY: refusing to write to "${remote}". The end-to-end suite may write only to: ${allowed}.`,
    );
  }
}
