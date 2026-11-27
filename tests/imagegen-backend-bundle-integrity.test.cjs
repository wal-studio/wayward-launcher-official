// Verify both the production 0.8.4 bundle and the isolated FLUX test overlay.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mainRoot = path.join(root, "app/src/main/assets/imagegen-backend");
const fluxRoot = path.join(root, "app/src/fluxTest/assets/imagegen-backend");
const mainManifest = JSON.parse(fs.readFileSync(path.join(mainRoot, "launcher-bundle.json"), "utf8"));
const fluxManifest = JSON.parse(fs.readFileSync(path.join(fluxRoot, "launcher-bundle.json"), "utf8"));
const installer = fs.readFileSync(path.join(root, "app/src/main/java/com/wayward/launcher/ImageGenBackendInstaller.java"), "utf8");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function verifyBundle(manifest, overlayRoot, fallbackRoot) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.backendVersion, "0.8.4");
  assert.equal(manifest.sourceCommit, "26d6c32e0b0abbb886e3029efd548b7ca6774401");
  assert.equal(manifest.sourceArchiveSha256, "dfd25e050dd0b98ec1c99c09634bd92b509efac428788273f84884e713e2c553");
  assert.equal(manifest.fileCount, 42);
  assert.equal(Object.keys(manifest.files).length, manifest.fileCount);
  let total = 0;
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const overlay = path.join(overlayRoot, ...relative.split("/"));
    const fallback = path.join(fallbackRoot, ...relative.split("/"));
    const file = fs.existsSync(overlay) ? overlay : fallback;
    assert.ok(fs.existsSync(file), "missing pinned backend asset: " + relative);
    const bytes = fs.readFileSync(file);
    total += bytes.length;
    assert.equal(digest(bytes), expected, "backend asset SHA-256 mismatch: " + relative);
  }
  assert.equal(total, manifest.totalBytes);
  return total;
}

const mainBytes = verifyBundle(mainManifest, mainRoot, mainRoot);
assert.equal(mainManifest.fluxTestOnly, undefined);
assert.match(installer, /SOURCE_ARCHIVE_SHA256\s*=\s*"dfd25e050dd0b98ec1c99c09634bd92b509efac428788273f84884e713e2c553"/);
assert.match(installer, /MAX_FILES\s*=\s*128/);
assert.match(installer, /MAX_TOTAL_BYTES\s*=\s*4L\s*\*\s*1024L\s*\*\s*1024L/);
assert.match(installer, /matchesBundledManifest\(context, destination\)/);
const mainRunner = fs.readFileSync(path.join(mainRoot, "wayward-imagegen/src/comfy/jobRunner.ts"), "utf8");
const mainUi = fs.readFileSync(path.join(mainRoot, "wayward-imagegen/ui/index.html"), "utf8");
assert.doesNotMatch(mainRunner, /fluxGenerate|fluxWorkerUrl/);
assert.doesNotMatch(mainUi, /imageProvider === 'launcher'|launcher provider unavailable/);

assert.equal(fluxManifest.buildVariant, "fluxTest");
assert.equal(fluxManifest.fluxTestOnly, true);
const fluxBytes = verifyBundle(fluxManifest, fluxRoot, mainRoot);
const fluxRunner = fs.readFileSync(path.join(fluxRoot, "wayward-imagegen/src/comfy/jobRunner.ts"), "utf8");
const fluxConfig = fs.readFileSync(path.join(fluxRoot, "wayward-imagegen/src/config.ts"), "utf8");
const fluxSettings = fs.readFileSync(path.join(fluxRoot, "wayward-imagegen/src/routes/generationSettings.ts"), "utf8");
const fluxImage = fs.readFileSync(path.join(fluxRoot, "wayward-imagegen/src/routes/image.ts"), "utf8");
const fluxUi = fs.readFileSync(path.join(fluxRoot, "wayward-imagegen/ui/index.html"), "utf8");
assert.match(fluxRunner, /async function fluxGenerate/);
assert.match(fluxRunner, /JSON\.stringify\(\{ prompt: prompt\.trim\(\) \}\)/);
assert.match(fluxRunner, /this\.finalize\(job/);
assert.match(fluxConfig, /fluxWorkerUrl: string/);
assert.match(fluxSettings, /providerLabel: 'Cloudflare FLUX'/);
assert.match(fluxImage, /if \(config\.imageProvider === 'flux'\) return 'nai'/);
assert.doesNotMatch(mainRunner, /fluxGenerate/);

const packageJson = JSON.parse(fs.readFileSync(path.join(mainRoot, "wayward-imagegen/package.json"), "utf8"));
assert.equal(packageJson.version, mainManifest.backendVersion);
console.log("Production bundle " + mainBytes + " bytes; isolated FLUX test overlay " + fluxBytes + " bytes; all 42-file SHA-256 manifests verified.");
