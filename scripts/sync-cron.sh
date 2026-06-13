#!/usr/bin/env bash
# Wrapper for running the sync from cron/launchd on a laptop.
# Logs to sync.log in the project root. Make executable: chmod +x scripts/sync-cron.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Ensure bun, ntn, and gh are on PATH under cron's minimal environment.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) sync start ===" >> sync.log
bun run src/cli.ts sync >> sync.log 2>&1
echo "=== sync end (exit $?) ===" >> sync.log
