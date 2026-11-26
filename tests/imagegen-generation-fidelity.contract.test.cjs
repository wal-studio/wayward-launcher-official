const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = path => fs.readFileSync(path, 'utf8');
const proxy = read('app/src/main/java/com/wayward/launcher/ImageGenProxy.java');
const directNai = read('app/src/main/java/com/wayward/launcher/NovelAiRequestProxy.java');
const main = read('app/src/main/java/com/wayward/launcher/MainActivity.java');
const bridge = read('app/src/main/assets/imagegen-studio-bridge.js');
const imageRoute = read('app/src/main/assets/imagegen-backend/wayward-imagegen/src/routes/image.ts');
const settingsRoute = read('app/src/main/assets/imagegen-backend/wayward-imagegen/src/routes/generationSettings.ts');
const naiClient = read('app/src/main/assets/imagegen-backend/wayward-imagegen/src/nai/client.ts');
const jobRunner = read('app/src/main/assets/imagegen-backend/wayward-imagegen/src/comfy/jobRunner.ts');
const service = read('app/src/main/java/com/wayward/launcher/ImageGenService.java');
const installer = read('app/src/main/java/com/wayward/launcher/ImageGenBackendInstaller.java');
assert.match(proxy, /Preserve the game's complete generation payload byte-for-byte/);
assert.doesNotMatch(proxy, /generation\.put\(["']workflow["']/);
assert.match(proxy, /out\.write\(requestBody\)/);
assert.match(directNai, /Base64\.decode\(bodyBase64/);
assert.match(directNai, /output\.write\(requestBody\)/);
assert.match(imageRoute, /const requestPrompt = body\.prompt/);
assert.match(imageRoute, /base\.imageUrl = imageUrlFor\(job\.media\.relativePath\)/);
assert.match(imageRoute, /NovelAI_프롬프트만들기\(config, scenePrompt, naiNegativePrompt\)/);
assert.match(imageRoute, /seed: body\.seed/);
assert.match(jobRunner, /NovelAI_이미지생성하기\(config, job\.prompt, job\.negativePrompt \|\| '', args\.seed\)/);
for (const field of ['naiModel','naiWidth','naiHeight','naiSteps','naiScale','naiSampler','naiNoiseSchedule','naiCommonPrompt','naiArtistPrompt','naiNegativePrompt']) {
  assert.ok(settingsRoute.includes(field), 'settings persistence must retain ' + field);
}
for (const field of ['naiModel','naiWidth','naiHeight','naiSteps','naiScale','naiSampler','naiNoiseSchedule']) {
  assert.ok(naiClient.includes('config.' + field), 'NAI request must apply configured ' + field);
}
assert.match(naiClient, /seed: actualSeed/);
assert.match(naiClient, /model: config\.naiModel/);
assert.match(settingsRoute, /unsupportedSettings: settings\\.imageProvider === 'nai' \\? comfyOnly : naiOnly/);
assert.ok(settingsRoute.includes("'loras'"), 'NAI mode must explicitly report Comfy-only LoRA settings as unsupported');
assert.match(main, /NovelAiRequestProxy\.dispatch/);
assert.match(main, /serveGeneratedImageRequest\(path, imageDiagnostics\)/);
assert.match(main, /path\.startsWith\("\/images\/__wayward_generated__\/"\)/);
assert.match(main, /IMAGE_MODE_PACKS_ONLY\.equals\(currentImageMode\(\)\)/);
assert.ok(main.includes('"situation".equals(segments[3])') && main.includes('"characters".equals(segments[3])'));
assert.ok(bridge.includes('parts[3] === "situation"') && bridge.includes('parts[3] === "characters"'));
assert.match(service, /ImageGenBackendInstaller/);
assert.match(installer, /launcher-bundle\.json/);
assert.doesNotMatch(main, /activeProfileId=profile\.id;treeUri=picked;tree=new SafTree\(picked\);saveProfiles\(\);/);
console.log('Generation payload, NAI settings/seed, portrait routing and CDN mode/URL contracts passed.');
