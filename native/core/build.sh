#!/usr/bin/env bash
# Builds the Rust core for every target and drops the outputs where the apps expect them:
#   desktop DLL  -> native/app/desktopApp/src/main/resources/win32-x86-64/ziptv_core.dll (JNA loads it from the classpath)
#   Android .so  -> native/app/androidApp/src/main/jniLibs/<abi>/libziptv_core.so
#   Kotlin API   -> native/app/shared/kotlin/com/ziptv/core/ziptv_core.kt
# Usage: native/core/build.sh [--skip-android]
#   FAST=1  dev build: no LTO, parallel codegen, no tests, phone ABI only (arm64-v8a) — ~1 min
#           instead of ~6. ABIS="x86" picks other ABIs (e.g. the TV emulator).
#           Release builds (optimized, all 4 ABIs) run on GitHub: .github/workflows/native-release.yml
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:/c/Users/$USERNAME/.cargo/bin:$PATH"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$LOCALAPPDATA/Android/Sdk/ndk/27.2.12479018}"
APP=../app

ABIS="${ABIS:-arm64-v8a armeabi-v7a x86_64 x86}"
if [[ -n "${FAST:-}" ]]; then
  # Same output paths as a release build, just the slow optimizations off.
  export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_OPT_LEVEL=1
  [[ "$ABIS" == "arm64-v8a armeabi-v7a x86_64 x86" ]] && ABIS=arm64-v8a
else
  cargo test --release
fi
cargo build --release

mkdir -p "$APP/desktopApp/src/main/resources/win32-x86-64"
cp target/release/ziptv_core.dll "$APP/desktopApp/src/main/resources/win32-x86-64/"

cargo run --release --bin uniffi-bindgen -- generate --no-format \
  --library target/release/ziptv_core.dll --language kotlin --out-dir "$APP/shared/kotlin"

if [[ "${1:-}" != "--skip-android" ]]; then
  cargo ndk $(printf -- '-t %s ' $ABIS) -o "$APP/androidApp/src/main/jniLibs" build --release
fi
echo "core build done"
