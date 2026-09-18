#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# REDEPLOY — rebuild the dashboard image and restart the container.
#
#   ./redeploy.sh              rebuild + restart + verify
#   ./redeploy.sh --control    also restart the host-side control plane
#
# WHY THIS EXISTS, AND WHY `docker compose restart` IS THE WRONG COMMAND:
#
# The dashboard's UI files are COPY'd INTO the image (Dockerfile), not
# bind-mounted — only `/bench` (the run artifacts) is mounted, read-only. So a
# `restart` re-runs the SAME image and serves the OLD board, silently. Editing
# board.js and restarting looks like it worked and changes nothing on screen.
#
# `up -d --build` is therefore mandatory after any edit to index.html, board.js,
# panels/ or sources/. This script exists so that is never forgotten.
#
# It then VERIFIES the deploy by fetching the served bytes back, because
# "the build succeeded" and "the browser is being served the new file" are two
# different claims and only the second one matters.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
PORT="${OKP_DASH_PORT:-8717}"

cd "$HERE"

echo "── rebuilding dashboard image ─────────────────────────────────────"
docker compose up -d --build 2>&1 | grep -Ev '^#' | tail -6

echo
echo "── waiting for the board to assemble ──────────────────────────────"
for i in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "  health ok after ${i} attempt(s)"
    break
  fi
  sleep 1
  if [ "$i" = 20 ]; then
    echo "  FAILED: /api/health never came up on :${PORT}"
    docker compose logs --tail 30 learning-index-dashboard
    exit 1
  fi
done

# Verify the SERVED bytes, not the build log. This is the check that catches a
# stale image being restarted instead of rebuilt.
echo
echo "── verifying served content ───────────────────────────────────────"
stale=0
for f in board.js board-actions.js history.js panels/chrome.js panels/create.js; do
  if ! curl -fsS -m 3 "http://127.0.0.1:${PORT}/${f}" | cmp -s - "$HERE/$f"; then
    echo "  STALE: the served ${f} differs from the file on disk"
    stale=1
  fi
done
[ "$stale" = 0 ] && echo "  served files match disk"

echo
echo "── source health ──────────────────────────────────────────────────"
curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/board" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for s in d.get('sources',[]):
    mark='ok ' if s['ok'] else 'UNWIRED'
    reason='' if s['ok'] else f\"  :: {(s.get('reason') or '')[:70]}\"
    print(f\"  {mark:8s} {s['id']}{reason}\")
"

if [ "${1:-}" = "--control" ]; then
  echo
  echo "── restarting control plane ───────────────────────────────────────"
  # One way to (re)start it: dev/Makefile, which hands it to its login agent
  # (dev/scripts/install-services.sh) so it does not belong to this shell.
  make --no-print-directory -C "$BENCH/../dev" control-restart < /dev/null
fi

echo
echo
echo "── using the board in a browser (check/board-check.mjs) ───────────"
node "$HERE/check/board-check.mjs"

echo "→ http://localhost:${PORT}"
