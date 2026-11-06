#!/usr/bin/env bash
# Builds the Rust core for every target and drops the outputs where the apps expect them:
#   desktop DLL  -> native/app/desktopApp/src/main/resources/win32-x86-64/ziptv_core.dll (JNA loads it from the classpath)
#   Android .so  -> native/app/androidApp/src/main/jniLibs/<abi>/libziptv_core.so
#   Kotlin API   -> native/app/shared/kotlin/com/ziptv/core/ziptv_core.kt
# Usage: native/core/build.sh [--skip-android]
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:/c/Users/$USERNAME/.cargo/bin:$PATH"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$LOCALAPPDATA/Android/Sdk/ndk/27.2.12479018}"
APP=../app

cargo test --release
cargo build --release

mkdir -p "$APP/desktopApp/src/main/resources/win32-x86-64"
cp target/release/ziptv_core.dll "$APP/desktopApp/src/main/resources/win32-x86-64/"

cargo run --release --bin uniffi-bindgen -- generate --no-format \
  --library target/release/ziptv_core.dll --language kotlin --out-dir "$APP/shared/kotlin"

if [[ "${1:-}" != "--skip-android" ]]; then
  cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 -o "$APP/androidApp/src/main/jniLibs" build --release
fi
echo "core build done"
