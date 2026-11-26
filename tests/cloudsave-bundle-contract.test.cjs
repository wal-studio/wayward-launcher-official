#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');

const main = fs.readFileSync('app/src/main/java/com/wayward/launcher/MainActivity.java', 'utf8');
const mod = fs.readFileSync('app/src/main/assets/wml/mods/cloud-save/mod.js', 'utf8');
const crypto = fs.readFileSync('app/src/main/assets/wml/mods/cloud-save/crypto.js', 'utf8');

assert.match(main, /ids\.add\("cloud-save"\)/,
  'the built-in CloudSave ID must be included in the launcher's WML folder list');
assert.match(main, /BUNDLED_CLOUD_SAVE_PREFIX\s*=\s*"wml\/mods\/cloud-save\/"/,
  'the APK asset overlay must be scoped to the CloudSave mod directory');
assert.match(main, /p\.startsWith\(BUNDLED_CLOUD_SAVE_PREFIX\)\)in=assets\.open\(p\)/,
  'missing game-folder/ZIP files must resolve from APK assets');
assert.match(main, /"wml\/mods\/mods\.js"\.equalsIgnoreCase\(p\)\)in=WmlModListBootstrap\.patch\(in\)/,
  'the default enable list must be patched only in the WebView response');

assert.match(mod, /id:\s*'cloud-save'/, 'bundled WML mod ID must be cloud-save');
assert.match(mod, /version:\s*'0\.6\.3'/, 'the launcher must bundle CloudSave 0.6.3');
assert.match(mod, /api\.loadScript\('crypto\.js'\)/, 'the mod must load its adjacent encryption module');
assert.match(mod, /waywardNativeSaveSlotText/, 'native Wayward save-row compatibility must be included');
assert.match(mod, /faithNativeSaveSlotText/, 'native Faith save-row compatibility must be included');

const scriptRefs = [...mod.matchAll(/api\.loadScript\(['"]([^'"]+)['"]\)/g)]
  .map(match => match[1]);
assert.deepEqual(scriptRefs, ['crypto.js'],
  'the APK must include every local script dependency and no missing sidecar');

assert.match(crypto, /encryptSnapshotEmbedded/, 'embedded-key encryption must be bundled');
assert.match(crypto, /decryptSnapshotEmbedded/, 'embedded-key decryption must be bundled');
assert.match(crypto, /AES-256-GCM/, 'the existing CloudSave encryption format must remain present');

console.log('Bundled CloudSave 0.6.3 asset contract passed');
