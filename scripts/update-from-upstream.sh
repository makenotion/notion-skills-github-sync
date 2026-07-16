#!/usr/bin/env bash
# Get the latest tool changes from upstream while keeping your own config.json.
# Run it from inside your clone:  ./scripts/update-from-upstream.sh
#
# For existing clones that predate `bun run update` / .gitattributes, this is the
# one to use — grab the raw file from GitHub if you don't have it locally yet.
set -e

cp config.json config.json.mine        # save your config
git fetch upstream
git merge --no-edit upstream/main || true   # pull latest (config.json conflict is expected)
cp config.json.mine config.json && rm config.json.mine   # put your config back
git add config.json
git commit -m "Update from upstream (kept my config.json)" || true

echo "✓ Done. Push it to your repo with:  git push origin HEAD"
