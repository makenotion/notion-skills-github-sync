#!/usr/bin/env bash
#
# setup.sh — bootstrap the dev environment for notion-skills-github-sync.
#
# What it guarantees:
#   1. Bun (>= 1.2) is installed. This is the ONLY hard prerequisite — the CLI
#      and every script run under Bun and import `.ts` directly (Node is not
#      supported).
#   2. Project dependencies are installed (`bun install`).
#
# It also reports on the optional CLIs that a real `sync` needs but that aren't
# required just to install, typecheck, or test the repo:
#   - ntn : the Notion CLI the sync shells out to for Notion reads.
#   - gh  : provides GitHub auth (the tool falls back to `gh auth token` when
#           GITHUB_TOKEN is unset).
# Pass --with-sync-tools to also install `ntn` automatically.
#
# Written in bash (not Bun) on purpose: it may need to run before Bun exists.
#
# Usage:
#   ./scripts/setup.sh                 # install Bun + deps, report optional CLIs
#   ./scripts/setup.sh --with-sync-tools  # also install the ntn CLI

set -euo pipefail

MIN_BUN_MAJOR=1
MIN_BUN_MINOR=2
WITH_SYNC_TOOLS=0

for arg in "$@"; do
  case "$arg" in
    --with-sync-tools) WITH_SYNC_TOOLS=1 ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# --- pretty output (degrades gracefully when stdout isn't a TTY) ------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# Repo root is the parent of this script's directory, regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Returns 0 if the installed Bun satisfies the minimum version.
bun_version_ok() {
  local version major minor
  version="$(bun --version 2>/dev/null | tr -d '[:space:]')" || return 1
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  if [ "$major" -gt "$MIN_BUN_MAJOR" ]; then return 0; fi
  if [ "$major" -eq "$MIN_BUN_MAJOR" ] && [ "$minor" -ge "$MIN_BUN_MINOR" ]; then return 0; fi
  return 1
}

# --- 1. Bun (required) ------------------------------------------------------
step "Checking for Bun (required, >= ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR})"

if have bun && bun_version_ok; then
  ok "Bun $(bun --version) is installed."
else
  if have bun; then
    warn "Bun $(bun --version) is older than ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}; upgrading."
  else
    warn "Bun is not installed; installing it now."
  fi

  # Official installer. Honors BUN_INSTALL; defaults to ~/.bun.
  if ! curl -fsSL https://bun.sh/install | bash; then
    fail "Failed to install Bun automatically."
    fail "Install it manually from https://bun.sh, then re-run this script."
    exit 1
  fi

  # Make bun usable in THIS shell without requiring a profile reload.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! have bun; then
    fail "Bun was installed but isn't on PATH for this session."
    fail "Open a new shell (or 'source' your profile) and re-run this script."
    exit 1
  fi
  if ! bun_version_ok; then
    fail "Installed Bun $(bun --version) is still below ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}."
    exit 1
  fi
  ok "Bun $(bun --version) installed."
  printf '%s    (make sure %s is on your PATH in new shells)%s\n' \
    "$DIM" "\$BUN_INSTALL/bin" "$RESET"
fi

# --- 2. Project dependencies ------------------------------------------------
step "Installing project dependencies (bun install)"
bun install
ok "Dependencies installed."

# --- 3. Optional CLIs for a full sync --------------------------------------
step "Checking optional tools (needed for 'bun run sync', not for install/test)"

# ntn: the Notion CLI the sync shells out to.
if have ntn; then
  ok "ntn (Notion CLI) is installed."
elif [ "$WITH_SYNC_TOOLS" -eq 1 ]; then
  warn "ntn not found; installing (--with-sync-tools)."
  if curl -fsSL https://ntn.dev | bash; then
    ok "ntn installed (may need a new shell to be on PATH)."
  else
    fail "Failed to install ntn. Install manually: curl -fsSL https://ntn.dev | bash"
  fi
else
  warn "ntn (Notion CLI) is not installed — required for 'bun run sync'."
  printf '%s    Install with: %scurl -fsSL https://ntn.dev | bash%s%s (or pass --with-sync-tools)%s\n' \
    "$DIM" "$CYAN" "$RESET" "$DIM" "$RESET"
fi

# GitHub auth: gh CLI or a GITHUB_TOKEN env var.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  ok "GITHUB_TOKEN is set (used for GitHub pushes)."
elif have gh; then
  ok "gh (GitHub CLI) is installed — the sync falls back to 'gh auth token'."
  printf '%s    Make sure you are logged in: %sgh auth login%s\n' "$DIM" "$CYAN" "$RESET"
else
  warn "No GitHub auth found — required for 'bun run sync'."
  printf '%s    Either set GITHUB_TOKEN, or install gh (https://cli.github.com) and run %sgh auth login%s.\n' \
    "$DIM" "$CYAN" "$RESET"
fi

# --- Done -------------------------------------------------------------------
step "Setup complete"
printf 'The repo is ready. Common commands:\n'
printf '  %sbun run typecheck%s   type-check the project\n' "$CYAN" "$RESET"
printf '  %sbun test%s            run the unit tests\n' "$CYAN" "$RESET"
printf '  %sbun run dry-run%s     preview a sync (needs config.json + ntn + GitHub auth)\n' "$CYAN" "$RESET"
printf '  %sbun run setup%s       guided Notion + GitHub setup wizard\n' "$CYAN" "$RESET"
