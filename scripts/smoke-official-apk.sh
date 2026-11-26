#!/usr/bin/env bash
set -euo pipefail

apk="/tmp/wayward-official-apk/WAL-Android-Launcher-1.0.0.apk"
test -s "$apk"
unzip -l "$apk" | grep -F "assets/imagegen-backend/launcher-bundle.json"
unzip -l "$apk" | grep -F "assets/imagegen-backend/wayward-imagegen/package.json"

adb install -r "$apk"
adb logcat -c
adb shell am start -W -n "com.wayward.launcher.official.wal/com.wayward.launcher.MainActivity"

pid=""
for attempt in $(seq 1 20); do
  pid="$(adb shell pidof com.wayward.launcher.official.wal | tr -d '\r' || true)"
  if [[ -n "$pid" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$pid" ]]; then
  adb logcat -d -t 5000 > "$RUNNER_TEMP/official-launch-logcat.txt"
  cat "$RUNNER_TEMP/official-launch-logcat.txt"
  exit 1
fi

if adb logcat -d -t 5000 | grep -A4 -B2 -F "Process: com.wayward.launcher.official.wal"; then
  echo "Official APK crashed during startup." >&2
  exit 1
fi

adb shell dumpsys activity activities | grep -F "com.wayward.launcher.official.wal"
echo "Official APK installed and launched successfully on Android 15."
