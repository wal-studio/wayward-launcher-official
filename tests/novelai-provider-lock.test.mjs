import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const main = read("app/src/main/java/com/wayward/launcher/MainActivity.java");
const service = read("app/src/main/java/com/wayward/launcher/ImageGenService.java");
const proxy = read("app/src/main/java/com/wayward/launcher/ImageGenProxy.java");
const remoteApi = read("app/src/main/java/com/wayward/launcher/RemoteGameImageApiClient.java");
const tokenStore = read("app/src/main/java/com/wayward/launcher/NovelAiTokenStore.java");
const settingsUi = read("app/src/main/java/com/wayward/launcher/NovelAiSettingsActivity.java");
const imageRoute = read("app/src/main/assets/imagegen-backend/wayward-imagegen/src/routes/image.ts");
const generationSettings = read("app/src/main/assets/imagegen-backend/wayward-imagegen/src/routes/generationSettings.ts");
const bridge = read("app/src/main/assets/imagegen-studio-bridge.js");
const embed = read("scripts/embed_imagegen_backend.py");

// Launcher mode remains authoritative: NAI is local/Keystore-backed, Comfy uses
// the launcher-selected endpoint, and Remote PC always traverses paired Host auth.
assert.match(main, /IMAGE_MODE_GENERATION/);
assert.match(main, /IMAGE_MODE_REMOTE_PC/);
assert.match(main, /NovelAiTokenStore\.readToken/);
assert.match(main, /savedWorkflow/);
assert.match(main, /"anima".equalsIgnoreCase\(savedWorkflow\)/,
  "launcher startup must preserve the user's selected Anima workflow while Comfy remains selected");
assert.match(proxy, /"novelai".equals\(launcherMode\) \? "nai"/);
assert.match(proxy, /String selectedWorkflow = settings\.optString\("imageProvider", "sdxl"\)/);
assert.match(proxy, /"anima".equals\(selectedWorkflow\) \? "anima" : "sdxl"/,
  "Comfy routing must preserve the Image Studio's selected Anima or SDXL workflow");
assert.match(proxy, /settings\.remove\("naiToken"\)/);
assert.match(proxy, /settings\.remove\("naiTokenClear"\)/);

// Remote model/settings discovery must use the authenticated, approved-root Host API.
for (const route of [
  "/api/generation/settings",
  "/api/generation/resources",
  "/api/generation/capabilities",
  "/api/generation/characters/discover-batch"
]) {
  assert.ok(remoteApi.includes(route), "Remote PC must route " + route + " through the paired Host");
}
assert.match(remoteApi, /RemoteHostClient\.requestAuthenticatedJsonEnvelope/);
assert.match(remoteApi, /body\.remove\("comfyUrl"\)/);
assert.match(remoteApi, /body\.remove\("modelsDirectory"\)/);
assert.match(remoteApi, /body\.remove\("naiToken"\)/);

// NAI gets its supported prompt controls, including user-edited character prompts.
// Local/character LoRA files are not silently passed as if NAI could load them.
assert.match(imageRoute, /workflow === 'anima' \|\| workflow === 'nai'/);
assert.match(imageRoute, /NovelAI_프롬프트만들기\(config, scenePrompt, naiNegativePrompt\)/);
assert.match(generationSettings, /router\.get\('\/api\/generation\/capabilities'/);
assert.match(generationSettings, /NAI 미지원/);
assert.match(generationSettings, /Comfy 미지원/);
assert.match(bridge, /data-wayward-image-support-badge/);
assert.match(bridge, /refreshSupportBadges/);
assert.match(bridge, /settingKeysForControl/);
assert.match(bridge, /paired-pc-comfyui/);
assert.match(bridge, /PC 자동 탐색/);
assert.doesNotMatch(bridge, /alert\(/,
  "unsupported-setting information must stay inline and never block the game with a popup");

// NAI credentials remain launcher-owned and encrypted on Android.
assert.match(service, /WAYWARD_FORCE_NOVELAI",\s*"1"/);
assert.match(service, /NovelAiTokenStore\.readToken\(this\)/);
assert.match(service, /builder\.environment\(\)\.put\("NAI_TOKEN",\s*token\)/);
assert.match(tokenStore, /KEY_ALIAS = "wayward\.image\.providers\.v1"/);
assert.match(tokenStore, /AES\/GCM\/NoPadding/);
assert.match(settingsUi, /NovelAiTokenStore\.saveToken\(this, ""\)/);
assert.match(embed, /persistedSettings = \{ \.\.\.settings, naiToken: '' \}/);

for (const retired of [
  "app/src/main/java/com/wayward/launcher/ImageGenLocalProviderServer.java",
  "app/src/main/java/com/wayward/launcher/ImageProviderActivity.java",
  "app/src/main/java/com/wayward/launcher/ImageProviderBridge.java",
  "app/src/main/java/com/wayward/launcher/ImageProviderClient.java",
  "app/src/main/java/com/wayward/launcher/ImageProviderStore.java"
]) {
  assert.equal(fs.existsSync(retired), false, "retired external provider source must remain removed: " + retired);
}

console.log("NAI/Comfy/Remote-PC provider routing contract passed.");
