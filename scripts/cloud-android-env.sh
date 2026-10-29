#!/usr/bin/env bash
# Source this file in the managed Linux cloud before using Android build tools.
bareun_tools_root="${BAREUN_CLOUD_TOOLS_ROOT:-/workspace/.expo-development}"
export JAVA_HOME="$bareun_tools_root/jdk-21"
export ANDROID_HOME="$bareun_tools_root/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$bareun_tools_root/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
export GRADLE_USER_HOME="$bareun_tools_root/gradle-cache"
export XDG_CACHE_HOME="$bareun_tools_root/cache"
export npm_config_cache="$bareun_tools_root/npm-cache"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
# Preserve the session's CA trust for Java-based SDK tools.
if [[ "${JAVA_OPTS:-}" != *javax.net.ssl.trustStore=* ]] && [ -r /etc/ssl/certs/java/cacerts ]; then
  export JAVA_OPTS="${JAVA_OPTS:-} -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
fi
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME" "$GRADLE_USER_HOME" "$XDG_CACHE_HOME"
unset bareun_tools_root
