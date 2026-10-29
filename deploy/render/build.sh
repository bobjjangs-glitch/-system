#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Expo export needs the development tools during the build, even in production.
npm ci --include=dev --no-audit --no-fund
# The web UI and API share an origin. Do not embed a previous API address.
env -u EXPO_PUBLIC_API_URL EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 CI=1 npm run export:web
npm prune --omit=dev --no-audit --no-fund
