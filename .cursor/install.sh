#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for notion-skills-github-sync.
# Installs the pinned runtime (Bun), the Notion `ntn` CLI, and project deps.
set -euo pipefail

# --- Bun: the repo's required runtime (Node.js is not supported) -------------
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# --- ntn: Notion reads shell out to this CLI --------------------------------
if [ ! -x "$HOME/.local/bin/ntn" ]; then
  curl -fsSL https://ntn.dev | bash
fi
export PATH="$HOME/.local/bin:$PATH"

# --- Project dependencies (from the committed lockfile) ---------------------
cd "$(dirname "$0")/.."
bun install --frozen-lockfile

# --- Make bun + ntn resolvable from any shell (login or not) ----------------
if sudo -n true 2>/dev/null; then
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  sudo ln -sf "$HOME/.local/bin/ntn" /usr/local/bin/ntn
fi

echo "bun    $(bun --version)"
echo "ntn    $(ntn --version)"
echo "install: ok"
