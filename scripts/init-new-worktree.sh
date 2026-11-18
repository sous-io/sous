#!/usr/bin/env bash

# Prepares a new git worktree of this repository so it is ready to work in: copies the gitignored
# files a fresh worktree lacks from the main checkout, installs the dependencies, and builds the
# agent files (CLAUDE.md, AGENTS.md, .claude/) with this worktree's own sous.
#
# Point an IDE's "run after a worktree is created" setting at it, or run it by hand from inside a
# worktree. Running it again is safe: it never overwrites a file the worktree already has.
#
# Paths come from the IDE's environment variables when it sets them (see resolve_paths), and from
# git otherwise, so the script also works with no IDE at all.

set -euo pipefail

# Gitignored files that git does not bring into a new worktree, and that nothing in the worktree
# can recreate. Paths are relative to the repository root. Everything else that is gitignored is
# either rebuilt below (node_modules, dist, the agent files) or personal to one checkout.
COPY_FROM_MAIN_CHECKOUT=(
  # The machine's answers to sous variables (GitHub login, branch prefix, task file folder).
  # `sous build` cannot ask for them without a terminal, so without this file the build fails.
  ".sous/.env.local"
)

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Sets WORKTREE (the new worktree), MAIN_CHECKOUT (the repository's main checkout) and
# WORKSPACE_NAME (a label for messages). To support another IDE, read its variables here.
resolve_paths() {
  # Orca
  WORKTREE="${ORCA_WORKTREE_PATH:-}"
  MAIN_CHECKOUT="${ORCA_ROOT_PATH:-}"
  WORKSPACE_NAME="${ORCA_WORKSPACE_NAME:-}"

  # No IDE: the worktree is the one the current directory is in.
  if [ -z "$WORKTREE" ]; then
    WORKTREE="$(git rev-parse --show-toplevel 2> /dev/null)" \
      || fail "The current directory is not inside a git worktree, and no IDE named one."
  fi
  # Every worktree shares the main checkout's .git directory, so its parent is the main checkout.
  if [ -z "$MAIN_CHECKOUT" ]; then
    MAIN_CHECKOUT="$(dirname "$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)")"
  fi
  if [ -z "$WORKSPACE_NAME" ]; then
    WORKSPACE_NAME="$(basename "$WORKTREE")"
  fi

  [ -d "$WORKTREE" ] || fail "The worktree $WORKTREE does not exist."
  [ -d "$MAIN_CHECKOUT" ] || fail "The main checkout $MAIN_CHECKOUT does not exist."
  WORKTREE="$(cd -P "$WORKTREE" && pwd)"
  MAIN_CHECKOUT="$(cd -P "$MAIN_CHECKOUT" && pwd)"
}

# Puts the Node version from .nvmrc first on the PATH when nvm is installed (an IDE often runs its
# commands in a shell that never loaded nvm), then checks the version against package.json.
use_project_node() {
  local nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -f .nvmrc ] && [ -s "$nvm_script" ]; then
    # nvm.sh reads unset variables, so -u is off while it loads and runs.
    set +u
    # shellcheck disable=SC1090
    . "$nvm_script"
    nvm use > /dev/null || say "nvm could not switch to the Node version in .nvmrc ($(cat .nvmrc)); using the one on the PATH."
    set -u
  fi

  command -v node > /dev/null || fail "Node is not on the PATH. This repository needs the version in .nvmrc."
  local required actual
  required="$(node -p 'require("./package.json").engines.node' | grep -o '[0-9]\+' | head -n 1)"
  actual="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$actual" -ge "$required" ] \
    || fail "Node $(node --version) is too old. This repository needs Node $required or later (see .nvmrc)."
}

# Sets PNPM to the command that runs pnpm: pnpm itself when it is on the PATH, otherwise corepack,
# which ships with Node and runs the pnpm version named in package.json's packageManager field.
find_pnpm() {
  if command -v pnpm > /dev/null; then
    PNPM=(pnpm)
  elif command -v corepack > /dev/null; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    PNPM=(corepack pnpm)
  else
    fail "Neither pnpm nor corepack is on the PATH. Install pnpm, or use a Node version that ships corepack."
  fi
}

copy_ignored_files() {
  if [ "$WORKTREE" = "$MAIN_CHECKOUT" ]; then
    say "This is the main checkout, so there is nothing to copy."
    return
  fi
  local file
  for file in "${COPY_FROM_MAIN_CHECKOUT[@]}"; do
    if [ -e "$WORKTREE/$file" ]; then
      say "  Kept $file: the worktree already has it."
    elif [ ! -e "$MAIN_CHECKOUT/$file" ]; then
      say "  Skipped $file: the main checkout does not have it."
    else
      mkdir -p "$(dirname "$WORKTREE/$file")"
      cp -Rp "$MAIN_CHECKOUT/$file" "$WORKTREE/$file"
      say "  Copied $file."
    fi
  done
}

main() {
  resolve_paths
  cd "$WORKTREE"

  say "Preparing the worktree \"$WORKSPACE_NAME\""
  say "  Worktree:      $WORKTREE"
  say "  Main checkout: $MAIN_CHECKOUT"
  say ""

  use_project_node
  find_pnpm

  say "Copying gitignored files from the main checkout:"
  copy_ignored_files
  say ""

  say "Installing dependencies with ${PNPM[*]} (Node $(node --version)):"
  "${PNPM[@]}" install
  say ""

  say "Building the agent files with this worktree's sous:"
  "${PNPM[@]}" run sous:build
  say ""

  say "The worktree \"$WORKSPACE_NAME\" is ready."
}

main "$@"
