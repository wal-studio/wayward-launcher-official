#!/usr/bin/env bash
set -euo pipefail

adb wait-for-device
boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
test "$boot_completed" = "1"

# The stock Pixel Launcher can trigger a system ANR dialog in headless CI even
# when the app under test is healthy. Stop home launchers before opening Wayward.
adb shell am force-stop com.google.android.apps.nexuslauncher || true
adb shell am force-stop com.android.launcher3 || true
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop com.wayward.launcher.official.debug || true
adb shell am start -W -n com.wayward.launcher.official.debug/com.wayward.launcher.MainActivity
sleep 6
adb shell pidof -s com.wayward.launcher.official.debug > /tmp/wayward-launcher-app-pid.txt
adb logcat -d -s AndroidRuntime:E > /tmp/wayward-launcher-crash.log
test -s /tmp/wayward-launcher-app-pid.txt && ! grep -q "Process: com.wayward.launcher.official.debug" /tmp/wayward-launcher-crash.log
adb shell uiautomator dump /sdcard/wayward-launcher-home.xml >/dev/null
adb pull /sdcard/wayward-launcher-home.xml /tmp/wayward-launcher-home.xml

# Recover once if Android left the Pixel Launcher ANR dialog on top.
if grep -q "Pixel Launcher isn't responding" /tmp/wayward-launcher-home.xml; then
  adb shell input tap 540 1363 || true
  sleep 3
  adb shell am force-stop com.google.android.apps.nexuslauncher || true
  adb shell am force-stop com.android.launcher3 || true
  adb shell am force-stop com.wayward.launcher.official.debug || true
  adb shell am start -W -n com.wayward.launcher.official.debug/com.wayward.launcher.MainActivity
  sleep 5
  adb shell uiautomator dump /sdcard/wayward-launcher-home.xml >/dev/null
  adb pull /sdcard/wayward-launcher-home.xml /tmp/wayward-launcher-home.xml
fi

mkdir -p artifacts
adb exec-out screencap -p > artifacts/android15-launcher-home.png
cp /tmp/wayward-launcher-home.xml artifacts/android15-launcher-home.xml
echo "=== Android 15 UI hierarchy ==="
cat /tmp/wayward-launcher-home.xml
! grep -q "Pixel Launcher isn't responding" /tmp/wayward-launcher-home.xml
