#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

: "${RENDER_EXTERNAL_URL:?Render must provide the public service URL.}"
: "${APP_DATA_DIR:?Set the dedicated test data directory.}"
: "${DISPATCH_BOOTSTRAP_TOKEN:?Generate the initial administrator registration code in Render.}"
export NODE_ENV=production
export HOST=0.0.0.0
export CORS_ORIGINS="${CORS_ORIGINS:-$RENDER_EXTERNAL_URL}"
exec npm run server
