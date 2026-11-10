#!/usr/bin/env bash
# Fire Drill demo: start Otari with a three-leg routing policy and drill it.
#
#   OPENROUTER_API_KEY=sk-or-... demo/run-demo.sh            # set up and run one drill
#   OPENROUTER_API_KEY=sk-or-... demo/run-demo.sh --setup-only
#
# Legs (override with FIREDRILL_DEMO_LEGS):
#   1. openrouter:openai/gpt-4o-mini                         real model, primary
#   2. openrouter:google/gemma-3-12b-it                      real model; breaks the tool-call
#                                                            arguments (every one of 30+ tries in testing)
#   3. openrouter:mistralai/mistral-small-3.2-24b-instruct   real, small open-weight model
#
# FIREDRILL_DEMO_FAKE=1 swaps leg 2 for demo/fake-leg, a local stub that always
# answers in prose. Use it only if leg 2 stops failing reliably, and say so on screen.
#
# Needs Docker with Compose, git, openssl, curl and Node 20+.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OTARI_DIR="${OTARI_DIR:-$REPO/vendor-ref/otari}"
ENV_FILE="$HERE/.env"
GATEWAY="http://localhost:${OTARI_PORT:-8000}"
POLICY="${FIREDRILL_DEMO_POLICY:-demo-chat}"
if [[ "${FIREDRILL_DEMO_FAKE:-0}" == "1" ]]; then
  DEFAULT_LEGS="openrouter:openai/gpt-4o-mini,drillfake:prose-only,openrouter:mistralai/mistral-small-3.2-24b-instruct"
else
  DEFAULT_LEGS="openrouter:openai/gpt-4o-mini,openrouter:google/gemma-3-12b-it,openrouter:mistralai/mistral-small-3.2-24b-instruct"
fi
LEGS="${FIREDRILL_DEMO_LEGS:-$DEFAULT_LEGS}"

say() { printf '\033[2m[demo]\033[0m %s\n' "$*" >&2; }
die() { printf 'demo: %s\n' "$*" >&2; exit 2; }

command -v docker >/dev/null || die "Docker is not installed. Install Docker Desktop or Docker Engine with Compose."
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker and run this again."

if [[ ! -d "$OTARI_DIR" ]]; then
  say "Cloning Otari into $OTARI_DIR"
  git clone --quiet --depth 1 https://github.com/mozilla-ai/otari "$OTARI_DIR"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  say "Writing $ENV_FILE with fresh keys (mode 0600)"
  umask 077
  {
    echo "OTARI_MASTER_KEY=$(openssl rand -hex 32)"
    echo "OTARI_SECRET_KEY=$(docker run --rm docker.io/mzdotai/otari:latest otari gen-secret-key)"
    echo "OTARI_PROVIDER_ACCOUNT_PEPPER=$(openssl rand -base64 32)"
    echo "OTARI_DATABASE_URL=postgresql://otari:otari@postgres:5432/otari"
    echo "OTARI_DEFAULT_PRICING=true"
  } > "$ENV_FILE"
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
[[ -n "$OPENROUTER_API_KEY" ]] || die "Set OPENROUTER_API_KEY (an OpenRouter key; the passing legs are real models)."
export OPENROUTER_API_KEY
export FIREDRILL_DEMO_DIR="$HERE"
export OTARI_CONFIG_PATH="$HERE/otari-config.yml"
MASTER_KEY="$(grep -E '^OTARI_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2-)"

compose_files=(-f "$OTARI_DIR/docker-compose.yml" -f "$HERE/docker-compose.override.yml")
# Extra compose files, space-separated (for example a host-network variant).
for extra in ${FIREDRILL_COMPOSE_FILES:-}; do compose_files+=(-f "$extra"); done
compose() {
  docker compose -p firedrill-demo --project-directory "$OTARI_DIR" --env-file "$ENV_FILE" "${compose_files[@]}" --profile code-exec "$@"
}

say "Starting Otari, Postgres, the code sandbox and the fake leg"
compose up -d --quiet-pull >/dev/null 2>&1 || compose up -d

say "Waiting for $GATEWAY/api/v1/health"
for _ in $(seq 1 90); do
  if curl -fsS "$GATEWAY/api/v1/health" 2>/dev/null | grep -q healthy; then break; fi
  sleep 2
done
curl -fsS "$GATEWAY/api/v1/health" 2>/dev/null | grep -q healthy || die "Otari did not become healthy. See: docker compose -p firedrill-demo logs otari"

IFS=, read -r LEG1 LEG2 LEG3 <<<"$LEGS"
say "Creating routing policy \"$POLICY\": $LEG1, then $LEG2, then $LEG3"
curl -fsS -o /dev/null -X POST "$GATEWAY/api/v1/routing/policies" \
  -H "Authorization: Bearer $MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"name\": \"$POLICY\", \"spec\": {\"select\": [{\"default\": \"$LEG1\"}], \"on_failure\": [\"$LEG2\", \"$LEG3\"]}}" \
  || die "Could not create the routing policy. See: docker compose -p firedrill-demo logs otari"

if [[ ! -f "$REPO/dist/cli.js" ]]; then
  say "Building firedrill"
  (cd "$REPO" && npm ci --silent && npm run build --silent)
fi

cat >&2 <<MSG

Ready. In your shell, load the admin key without printing it:

  export OTARI_BASE_URL=$GATEWAY
  export OTARI_ADMIN_KEY="\$(grep ^OTARI_MASTER_KEY= demo/.env | cut -d= -f2-)"

Then run:  firedrill $POLICY --samples demo/samples.jsonl
(Install the command once with: npm install -g .)
Dashboard: $GATEWAY/  (sign in with the same master key)

MSG

[[ "${1:-}" == "--setup-only" ]] && exit 0

say "Running the drill"
set +e
OTARI_BASE_URL="$GATEWAY" OTARI_ADMIN_KEY="$MASTER_KEY" node "$REPO/dist/cli.js" "$POLICY" --samples "$HERE/samples.jsonl" --budget 0.10
code=$?
set -e
say "firedrill exited with code $code"
exit "$code"
