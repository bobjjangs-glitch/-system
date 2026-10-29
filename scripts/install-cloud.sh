#!/usr/bin/env bash
set -euo pipefail

# Keep tools and caches outside the application checkout.
repo_dir=/workspace/-system
dev_dir=/workspace/.expo-development
app_dir="${APP_PROJECT_DIR:-$repo_dir}"
mkdir -p "$dev_dir/npm-cache" "$dev_dir/cache" "$dev_dir/logs" "$dev_dir/tools"
export npm_config_cache="$dev_dir/npm-cache"
export XDG_CACHE_HOME="$dev_dir/cache"
export EXPO_NO_TELEMETRY=1
export NODE_USE_ENV_PROXY=1

cd "$repo_dir"
command -v git >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major === 24 && minor >= 3)) { console.error("Use the managed Node.js 24 LTS runtime (24.3 or later). Found: " + process.version); process.exit(1); }'
node --version
npm --version

# Versioned local CLIs; do not install the deprecated global expo-cli.
npm install --prefix "$dev_dir/tools" --no-audit --no-fund --save-exact \
  create-expo-app@5.0.0 expo-doctor@1.21.5 eas-cli@26.0.0
"$dev_dir/tools/node_modules/.bin/create-expo-app" --version
"$dev_dir/tools/node_modules/.bin/expo-doctor" --version
"$dev_dir/tools/node_modules/.bin/eas" --version

if [ ! -f "$app_dir/package.json" ] && [ -f "$repo_dir/mobile/package.json" ]; then
  app_dir="$repo_dir/mobile"
fi
if [ ! -f "$app_dir/package.json" ]; then
  printf '%s\n' 'Expo tooling is installed. This repository has no app yet; no application files were generated.'
  exit 0
fi

cd "$app_dir"
node -e 'const p = require("./package.json"); if (!(p.dependencies?.expo || p.devDependencies?.expo)) { console.error("The selected package is not an Expo app. Set APP_PROJECT_DIR to the existing Expo app directory."); process.exit(1); }'
if [ ! -f package-lock.json ] && [ ! -f npm-shrinkwrap.json ]; then
  printf '%s\n' 'An npm lockfile is required for reproducible installation. Create or repair it in the app development task; setup leaves manifests and lockfiles unchanged.' >&2
  exit 1
fi
npm ci --no-audit --no-fund
./node_modules/.bin/expo --version
./node_modules/.bin/expo config --type public --json > /dev/null
if [ "${BAREUN_PREPARE_ANDROID:-1}" = 1 ]; then
  python3 scripts/setup-cloud-android.py --with-emulator
fi
printf 'Expo dependencies installed in %s. Follow the saved start skill to run Metro.\n' "$app_dir"
