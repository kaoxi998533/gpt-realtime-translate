#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="$SDK_DIR/build-tools/36.1.0"
ANDROID_JAR="$SDK_DIR/platforms/android-36.1/android.jar"
OUT_DIR="$ANDROID_DIR/build-manual"
KEYSTORE="$ANDROID_DIR/debug.keystore"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/compiled-res" "$OUT_DIR/gen" "$OUT_DIR/classes" "$OUT_DIR/dex" "$OUT_DIR/out"

"$BUILD_TOOLS/aapt2" compile --dir "$ANDROID_DIR/app/src/main/res" -o "$OUT_DIR/compiled-res"
"$BUILD_TOOLS/aapt2" link \
  -I "$ANDROID_JAR" \
  --manifest "$ANDROID_DIR/app/src/main/AndroidManifest.xml" \
  --min-sdk-version 26 \
  --target-sdk-version 36 \
  --java "$OUT_DIR/gen" \
  -A "$ROOT_DIR/public" \
  -o "$OUT_DIR/out/realtime-translate-unsigned.apk" \
  "$OUT_DIR"/compiled-res/*.flat

javac \
  -source 17 \
  -target 17 \
  -classpath "$ANDROID_JAR" \
  -d "$OUT_DIR/classes" \
  "$OUT_DIR/gen/com/example/realtimetranslate/R.java" \
  "$ANDROID_DIR/app/src/main/java/com/example/realtimetranslate/MainActivity.java"

"$BUILD_TOOLS/d8" \
  --min-api 26 \
  --lib "$ANDROID_JAR" \
  --output "$OUT_DIR/dex" \
  "$OUT_DIR"/classes/com/example/realtimetranslate/*.class

cp "$OUT_DIR/out/realtime-translate-unsigned.apk" "$OUT_DIR/out/realtime-translate-with-dex.apk"
zip -q -j "$OUT_DIR/out/realtime-translate-with-dex.apk" "$OUT_DIR/dex/classes.dex"
"$BUILD_TOOLS/zipalign" -f 4 "$OUT_DIR/out/realtime-translate-with-dex.apk" "$OUT_DIR/out/realtime-translate-aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
fi

"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$OUT_DIR/out/realtime-translate-debug.apk" \
  "$OUT_DIR/out/realtime-translate-aligned.apk"

"$BUILD_TOOLS/apksigner" verify --verbose "$OUT_DIR/out/realtime-translate-debug.apk"
echo "APK: $OUT_DIR/out/realtime-translate-debug.apk"
