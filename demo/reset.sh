#!/usr/bin/env bash
# Return the demo stack to a clean state between takes: an empty database
# (no usage rows, keys or policies from earlier takes), then the demo policy
# again. Keeps demo/.env, so OTARI_ADMIN_KEY in your shell stays valid.
#
#   OPENROUTER_API_KEY=sk-or-... demo/reset.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OTARI_DIR="${OTARI_DIR:-$REPO/vendor-ref/otari}"
ENV_FILE="$HERE/.env"
[[ -f "$ENV_FILE" ]] || { echo "reset: nothing to reset; run demo/run-demo.sh first." >&2; exit 2; }

export FIREDRILL_DEMO_DIR="$HERE"
export OTARI_CONFIG_PATH="$HERE/otari-config.yml"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-unused-for-teardown}"
compose_files=(-f "$OTARI_DIR/docker-compose.yml" -f "$HERE/docker-compose.override.yml")
for extra in ${FIREDRILL_COMPOSE_FILES:-}; do compose_files+=(-f "$extra"); done

echo "[reset] Stopping the stack and deleting its database volume" >&2
docker compose -p firedrill-demo --project-directory "$OTARI_DIR" --env-file "$ENV_FILE" "${compose_files[@]}" \
  --profile code-exec down -v --remove-orphans >/dev/null 2>&1

if [[ "$OPENROUTER_API_KEY" == "unused-for-teardown" ]]; then unset OPENROUTER_API_KEY; fi
exec "$HERE/run-demo.sh" --setup-only
