#!/usr/bin/env bash
# Build this fork's image on the machine that runs it (docs/PICKUP-DEPLOY.md).
# Needs Docker only: the CS2 module is built in a throwaway Node container.
#
#   scripts/pop-build-image.sh
#
# It builds the CS2 code module from this checkout, signed with a key made
# for this build, then the image `pop-tournament:current`, and writes
# docker/pop-image.env with that key's public half (MODULE_TRUSTED_KEYS), so
# the instance trusts and installs the module the image carries.
#
# The module gets a version above the published one with the same platform
# version (x.y.<patch * 10000000 + minutes since 2026-11-01>), so an instance
# that has the published CS2 module updates to this one at its next start,
# and each later build is newer than the last.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null || { echo "pop-build-image: docker is not installed" >&2; exit 1; }

PLATFORM_VERSION="$(sed -n 's/^  "version": "\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p' package.json | head -1)"
[ -n "$PLATFORM_VERSION" ] || { echo "pop-build-image: no version in package.json" >&2; exit 1; }
IFS=. read -r MAJOR MINOR PATCH <<< "$PLATFORM_VERSION"
MINUTES=$(( ( $(date -u +%s) - 1793491200 ) / 60 ))
[ "$MINUTES" -gt 0 ] && [ "$MINUTES" -lt 10000000 ] || { echo "pop-build-image: check this machine's clock" >&2; exit 1; }
MODULE_VERSION="$MAJOR.$MINOR.$(( PATCH * 10000000 + MINUTES ))"
NODE_IMAGE="${NODE_IMAGE:-public.ecr.aws/docker/library/node:24}"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

echo "Building the CS2 module $MODULE_VERSION (platform $PLATFORM_VERSION)..."
# node_modules stay in Docker volumes, not in the checkout: the image build
# would copy api/node_modules and client/node_modules in with the source.
docker run --rm \
  -v "$ROOT":/app -w /app \
  -v pop-tournament-nm-root:/app/node_modules \
  -v pop-tournament-nm-api:/app/api/node_modules \
  -v pop-tournament-nm-client:/app/client/node_modules \
  -e AT_MODULE_VERSION="$MODULE_VERSION" \
  "$NODE_IMAGE" \
  bash -c 'corepack enable && yarn install --frozen-lockfile --network-timeout 300000 >/dev/null && bash scripts/build-module-snapshot.sh --ephemeral' \
  | tee "$LOG"

KEY="$(sed -n 's/^MODULE_TRUSTED_KEYS=//p' "$LOG" | tail -1)"
[ -n "$KEY" ] || { echo "pop-build-image: the module build printed no key" >&2; exit 1; }
ls api/bundled-modules/cs2-"$MODULE_VERSION".atmod >/dev/null

echo "Building the image..."
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
docker build -f docker/Dockerfile -t "pop-tournament:$TAG" -t pop-tournament:current .

# Not a secret: the public half of a key whose private half is already gone.
printf 'MODULE_TRUSTED_KEYS=%s\n' "$KEY" > docker/pop-image.env

echo
echo "Built pop-tournament:$TAG (also tagged pop-tournament:current)."
echo "CS2 module $MODULE_VERSION; its key is in docker/pop-image.env."
echo "Start it with:"
echo "  docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.pop.yml up -d"
