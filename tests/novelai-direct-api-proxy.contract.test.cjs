const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const main = read("app/src/main/java/com/wayward/launcher/MainActivity.java");
const bridge = read("app/src/main/assets/imagegen-studio-bridge.js");
const imageProxy = read("app/src/main/java/com/wayward/launcher/ImageGenProxy.java");
const naiProxy = read("app/src/main/java/com/wayward/launcher/NovelAiRequestProxy.java");

assert.match(bridge, /function managedApiEndpoint\(path, directNovelAi\)/);
assert.match(bridge, /return LOCAL_ORIGIN \+ "\/api\/nai-compat" \+ url\.pathname/);
assert.match(bridge, /url\.hostname\.toLowerCase\(\) === "image\.novelai\.net"/);
assert.match(bridge, /request\.method\.toUpperCase\(\) === "POST"/);
assert.match(bridge, /managedApiEndpoint\(url\.pathname \+ url\.search, directNovelAiGeneration\)/);
assert.match(main, /static boolean isLauncherImageGenerationMode\(android\.content\.Context context\)/);
assert.match(main, /static boolean isLauncherImageProvider\(android\.content\.Context context,String provider\)/);
assert.match(main, /if \(!IMAGE_MODE_GENERATION\.equals\(currentImageMode\(\)\)\)/);
assert.match(main, /NovelAiTokenStore\.readToken\(this\)/);
assert.match(main, /synchronizeImageGenProviderSetting\(state,mode,launcherComfyUrl\)/);
assert.match(main, /settings\.put\("comfyUrl",comfyUrl\)/);
assert.match(main, /value\.put\("engine","off"\)/);
assert.doesNotMatch(main.slice(main.indexOf("private void openImageGenPanel()"), main.indexOf("private void startManagedImageGenServer")),
  /ensureImageGenServer\(tree, openSettings\)/);
assert.match(main, /path\.startsWith\("\/api\/nai-compat\/"\)[\s\S]*?NovelAiRequestProxy\.dispatch\(web,requestId,method,path,headersJson,bodyBase64\)/);
assert.match(naiProxy, /NAI_ORIGIN = "https:\/\/image\.novelai\.net"/);
assert.match(naiProxy, /MainActivity\.isLauncherImageProvider\(context, "novelai"\)/);
assert.match(naiProxy, /NovelAiTokenStore\.readToken\(context\)/);
assert.match(naiProxy, /Authorization", "Bearer "/);
assert.match(naiProxy, /private static String allowedEndpoint/);
assert.match(naiProxy, /MAX_REQUEST_BYTES = 8 \* 1024 \* 1024/);
assert.match(naiProxy, /MAX_RESPONSE_BYTES = 64 \* 1024 \* 1024/);

assert.match(imageProxy, /MainActivity\.isLauncherImageGenerationMode\(appContext\)/);
assert.match(imageProxy, /stripGameProviderEndpointOverrides\(safePath\)/);
assert.match(imageProxy, /settings\.put\("imageProvider", provider\)/);
assert.match(imageProxy, /settings\.remove\("naiToken"\)/);
assert.match(imageProxy, /settings\.remove\("comfyUrl"\)/);

console.log("Direct NovelAI API allowlist, native token proxy, provider-mode checks, and game-settings policy verified.");
