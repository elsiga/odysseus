# Odysseus Android app (Slice B) — build & install

The Android app is a Capacitor wrapper that loads `https://chat.elsiga.ch` in a
native WebView, with a Capacitor-only service worker (`static/sw-native.js`) for
cold-offline. It is built on the Linux server.

## Build the APK
```
./mobile/build-apk.sh        # → dist/odysseus.apk
```
`mobile/android/` and `dist/` are gitignored (generated / binary). Re-run any time.

The build requires a full JDK 17 (not just a JRE — Gradle needs `jlink`); the
script defaults `JAVA_HOME` to `/home/elsiga/jdks/jdk-17.0.19+10`, overridable
via the `JAVA_HOME` env var.

## Install on a device (USB debugging on) or emulator
```
adb install -r dist/odysseus.apk
```
Or download `dist/odysseus.apk` (scp) and open it on the phone to sideload.

## First run
Launch **online once** and log in (TOTP) so the service worker caches the app
shell. After that, a cold launch works offline (Notes edits queue locally and
sync on reconnect).
