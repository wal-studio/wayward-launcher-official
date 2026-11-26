import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manager = readFileSync("app/src/main/java/com/wayward/launcher/OfficialUpdateManager.java", "utf8");
const activity = readFileSync("app/src/main/java/com/wayward/launcher/MainActivity.java", "utf8");
const build = readFileSync("scripts/build-official-release-v1.3.ps1", "utf8");

function section(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `missing source marker: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return source.slice(a, b);
}

const discovery = section(manager,
  "private static Update findLatestFromApi(",
  "static boolean isPublishedStableRelease(");
assert.doesNotMatch(discovery, /download\(/);
assert.doesNotMatch(discovery, /verifyApk\(/);
assert.match(discovery, /isPublishedStableRelease\(release\)/);
assert.match(discovery, /candidateFromRelease\(/);
assert.match(discovery, /WAL-Android-Launcher-.*release\.json/);

const install = section(manager,
  "public static void install(Context context, Update update)",
  "private static void requestInstallPermissionOrContinue(");
assert.match(install, /download\(update\.apkUrl, apk, update\.apkBytes\)/);
assert.match(install, /verifyApk\(app, apk, update\.sha256/);
assert.match(install, /DOWNLOADING\.compareAndSet\(false, true\)/);

assert.match(manager, /draft", true\)[\s\S]*release\.optBoolean\("prerelease", true\)/);
assert.match(build, /com\.wayward\.launcher\.official\.wal/);
assert.match(manager, /D9BE7443EB247D27C958CC4250D7F5D1E078F740/);
assert.match(manager, /contentLength/);
assert.match(manager, /APK SHA-256 mismatch/);
assert.match(manager, /APK signer does not match/);
assert.doesNotMatch(manager, /wayward-launcher-official\/releases/);

const updateDialog = section(activity,
  "private void showOfficialUpdateDialog(",
  "private void checkOfficialUpdatesManually(");
assert.match(updateDialog, /현재 버전:/);
assert.match(updateDialog, /신규 버전:/);
assert.match(updateDialog, /나중에/);
assert.match(updateDialog, /OfficialUpdateManager\.dismiss\(this,update\)/);
assert.match(updateDialog, /OfficialUpdateManager\.install\(this,update\)/);

console.log("PASS: discovery checks published stable metadata and release attestation without downloading APK bytes");
console.log("PASS: APK download, size, SHA-256, package and signer checks begin only after explicit Update selection");
console.log("PASS: automatic update dialog shows current/new versions and persists Later dismissal");
