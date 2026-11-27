const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const gradle = read("app/build.gradle");
const main = read("app/src/main/java/com/wayward/launcher/MainActivity.java");
const proxy = read("app/src/main/java/com/wayward/launcher/ImageGenProxy.java");
const installer = read("app/src/main/java/com/wayward/launcher/ImageGenBackendInstaller.java");
const productionRunner = read("app/src/main/assets/imagegen-backend/wayward-imagegen/src/comfy/jobRunner.ts");
const fluxRunner = read("app/src/fluxTest/assets/imagegen-backend/wayward-imagegen/src/comfy/jobRunner.ts");
const fluxSettings = read("app/src/fluxTest/assets/imagegen-backend/wayward-imagegen/src/routes/generationSettings.ts");
const fluxManifest = JSON.parse(read("app/src/fluxTest/assets/imagegen-backend/launcher-bundle.json"));

assert.match(gradle, /fluxTest\s*\{/);
assert.match(gradle, /applicationIdSuffix '\.fluxtest'/);
assert.match(gradle, /buildConfigField 'boolean', 'WAL_FLUX_TEST', 'true'/);
assert.match(main, /openFluxEndpointSettings\(\)/);
assert.match(main, /KEY_FLUX_URL="flux_worker_url"/);
assert.match(main, /static String fluxWorkerUrl\(android\.content\.Context context\)/);
assert.match(main, /startManagedImageGenServer\("flux",endpoint\)/);
assert.match(main, /config\.put\("imageProvider",BuildConfig\.WAL_FLUX_TEST&&"flux"\.equals\(mode\)\?"flux"/);
assert.match(main, /settings\.put\("fluxWorkerUrl",comfyUrl/);
assert.match(proxy, /BuildConfig\.WAL_FLUX_TEST&&"flux"\.equals\(launcherMode\)/);
assert.match(proxy, /settings\.put\("fluxWorkerUrl",MainActivity\.fluxWorkerUrl\(appContext\)\)/);
assert.doesNotMatch(productionRunner, /fluxGenerate|fluxWorkerUrl/);
assert.match(fluxRunner, /async function fluxGenerate/);
assert.match(fluxRunner, /JSON\.stringify\(\{ prompt: prompt\.trim\(\) \}\)/);
assert.match(fluxRunner, /this\.finalize\(job/);
assert.match(fluxSettings, /providerLabel: 'Cloudflare FLUX'/);
assert.equal(fluxManifest.buildVariant, "fluxTest");
assert.equal(fluxManifest.fluxTestOnly, true);
assert.match(installer, /matchesBundledManifest\(context, destination\)/);

console.log("FLUX Worker is isolated to the fluxTest backend overlay and selected only by the test APK.");
