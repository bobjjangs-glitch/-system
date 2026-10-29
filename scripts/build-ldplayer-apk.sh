#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

bareun_tools_dir="${BAREUN_CLOUD_TOOLS_ROOT:-/workspace/.expo-development}"
if [[ -d "$bareun_tools_dir/android-sdk" ]]; then
  source scripts/cloud-android-env.sh
fi
: "${ANDROID_HOME:?Android SDK is required.}"
if [[ ! -f android/gradlew ]]; then
  printf '%s\n' 'Generate the native project with npx expo prebuild --clean --platform android first.' >&2
  exit 1
fi
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://bareun-dispatch-test.onrender.com}"
export NODE_ENV=production
export EXPO_OFFLINE=1
export EXPO_NO_TELEMETRY=1
export CI=1
bareun_workers="${BAREUN_GRADLE_WORKERS:-2}"
if [[ ! "$bareun_workers" =~ ^[1-4]$ ]]; then
  printf '%s\n' 'BAREUN_GRADLE_WORKERS must be between 1 and 4.' >&2
  exit 1
fi

# Release mode embeds the JS bundle; the generated project's test signing key
# makes this a test APK, not the company's production-signed employee build.
bash android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=x86_64 --no-parallel --max-workers="$bareun_workers" \
  --build-cache --console=plain "$@"

bareun_apk=android/app/build/outputs/apk/release/app-release.apk
if [[ ! -f "$bareun_apk" ]]; then
  printf '%s\n' 'Gradle did not produce the expected signed test APK.' >&2
  exit 1
fi
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$bareun_apk"
bareun_output_dir="${BAREUN_APK_OUTPUT_DIR:-/workspace/artifacts}"
mkdir -p "$bareun_output_dir"
bareun_revision="$(git rev-parse --short HEAD)"
bareun_output="$bareun_output_dir/bareun-dispatch-ldplayer-x86_64-test-$bareun_revision.apk"
cp "$bareun_apk" "$bareun_output"
sha256sum "$bareun_output" > "$bareun_output.sha256"
printf 'Verified LDPlayer test APK: %s\n' "$bareun_output"
