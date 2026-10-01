#!/usr/bin/env bash
# Isolated registry integration test for Phase 06.
# Boots an ephemeral local registry on 127.0.0.1, runs the
# dockerImageRegistry integration suite against it, then cleans up.
# Does NOT touch the Compose registry service or any volumes.
set -euo pipefail

PORT="${REGISTRY_TEST_PORT:-}"
if [[ -z "$PORT" ]]; then
  for candidate in $(seq 5051 5099); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/${candidate}") 2>/dev/null; then
      PORT="$candidate"
      break
    fi
  done
fi

if [[ -z "$PORT" ]]; then
  echo "no free port found for test registry" >&2
  exit 1
fi

NAME="deploykit-registry-test-${PORT}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "starting ephemeral registry ${NAME} on 127.0.0.1:${PORT}"
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:5000" registry:2.8.3 >/dev/null

echo "waiting for registry /v2/ ..."
for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:${PORT}/v2/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fs "http://127.0.0.1:${PORT}/v2/" >/dev/null

DEPLOYKIT_TEST_REGISTRY_HOST="127.0.0.1:${PORT}" \
DEPLOYKIT_TEST_REGISTRY_CONTAINER="${NAME}" \
  npx tsx --test src/infrastructure/registry/dockerImageRegistry.integration.test.ts
