#!/usr/bin/env bash
# Build the Odysseus Android APK on this Linux box and drop it in dist/ for easy download.
set -euo pipefail
cd "$(dirname "$0")"                     # → mobile/
export ANDROID_HOME="${ANDROID_HOME:-/home/elsiga/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-/home/elsiga/jdks/jdk-17.0.19+10}"
export PATH="$JAVA_HOME/bin:$PATH"

# Copy the committed local-first sync bundle into the webDir so the shell is self-contained.
mkdir -p www/js
cp ../static/js/productivity/sync-core.js www/js/sync-core.js

npm install
node build.mjs                          # bundle src/ → www/js/app.js
[ -d android ] || npx cap add android
npx cap sync android

( cd android && ./gradlew --no-daemon assembleDebug )

mkdir -p ../dist
cp android/app/build/outputs/apk/debug/app-debug.apk ../dist/odysseus.apk
echo "APK → dist/odysseus.apk ($(du -h ../dist/odysseus.apk | cut -f1))"
