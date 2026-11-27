const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const main = read("app/src/main/java/com/wayward/launcher/MainActivity.java");
const bridge = read("app/src/main/assets/imagegen-studio-bridge.js");
const imageProxy = read("app/src/main/java/com/wayward/launcher/ImageGenProxy.java");
const jobRunner = read("app/src/main/assets/imagegen-backend/wayward-imagegen/src/comfy/jobRunner.ts");

assert.match(bridge, /function managedApiEndpoint\(path\)/);
assert.match(bridge, /url\.hostname\.toLowerCase\(\) === "image\.novelai\.net"/);
assert.match(bridge, /직접 NovelAI API 호출은 지원하지 않습니다/);
assert.doesNotMatch(bridge, /api\/nai-compat/);
assert.doesNotMatch(main, /NovelAiRequestProxy\.dispatch/);
assert.doesNotMatch(main, /NovelAiRequestProxy/);
assert.doesNotMatch(imageProxy, /stripGameProviderEndpointOverrides/);
assert.match(imageProxy, /final String localPath=safePath/);
assert.match(imageProxy, /settings\.put\("imageProvider", provider\)/);
assert.match(imageProxy, /settings\.remove\("naiToken"\)/);
assert.match(imageProxy, /settings\.remove\("naiTokenClear"\)/);
assert.match(imageProxy, /settings\.remove\("comfyUrl"\)/);
assert.doesNotMatch(imageProxy, /launcherProviderUrl|launcherProfileId|launcherProviderToken/);
assert.match(jobRunner, /NovelAI_이미지생성하기\(config, job\.prompt, job\.negativePrompt \|\| '', args\.seed\)/);
assert.doesNotMatch(jobRunner, /launcherGenerate|8190\/generate|launcherProvider/);

console.log("Direct NovelAI adapter removal and core NAI JobRunner routing verified.");
