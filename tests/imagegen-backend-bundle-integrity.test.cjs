// The reviewed vendored bundle is the source of truth; verify every file against its manifest.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assetRoot = path.join(root, "app/src/main/assets/imagegen-backend");
const manifest = JSON.parse(fs.readFileSync(path.join(assetRoot, "launcher-bundle.json"), "utf8"));
const installer = fs.readFileSync(path.join(root, "app/src/main/java/com/wayward/launcher/ImageGenBackendInstaller.java"), "utf8");

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.backendVersion, "0.8.4");
assert.equal(manifest.sourceCommit, "26d6c32e0b0abbb886e3029efd548b7ca6774401");
assert.equal(manifest.sourceArchiveSha256, "dfd25e050dd0b98ec1c99c09634bd92b509efac428788273f84884e713e2c553");
assert.equal(manifest.fileCount, 42);
assert.equal(Object.keys(manifest.files).length, manifest.fileCount);

let totalBytes = 0;
for (const [relative, expectedHash] of Object.entries(manifest.files)) {
  const file = path.join(assetRoot, ...relative.split("/"));
  assert.ok(fs.existsSync(file), "missing pinned backend asset: " + relative);
  const bytes = fs.readFileSync(file);
  totalBytes += bytes.length;
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expectedHash,
    "backend asset SHA-256 mismatch: " + relative);
}
assert.equal(totalBytes, manifest.totalBytes);
assert.match(installer, /SOURCE_ARCHIVE_SHA256\s*=\s*"dfd25e050dd0b98ec1c99c09634bd92b509efac428788273f84884e713e2c553"/);
assert.match(installer, /MAX_FILES\s*=\s*128/);
assert.match(installer, /MAX_TOTAL_BYTES\s*=\s*4L\s*\*\s*1024L\s*\*\s*1024L/);

const packageJson = JSON.parse(fs.readFileSync(path.join(assetRoot, "wayward-imagegen/package.json"), "utf8"));
assert.equal(packageJson.version, manifest.backendVersion);
for (const required of [
  "wayward-imagegen/src/cli.ts",
  "wayward-imagegen/src/server.ts",
  "wayward-imagegen/src/config.ts",
  "wayward-imagegen/src/nai/client.ts",
  "wayward-imagegen/src/routes/image.ts"
]) assert.ok(manifest.files[required], "required backend entry missing from manifest: " + required);

console.log("Vendored ImageGen 0.8.4 bundle: " + manifest.fileCount + " files, " + totalBytes + " bytes, and every SHA-256 verified.");
