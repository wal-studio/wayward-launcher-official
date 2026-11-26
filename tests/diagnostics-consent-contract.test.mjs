import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync("app/src/main/java/com/wayward/launcher/MainActivity.java", "utf8");
const logger = readFileSync("app/src/main/java/com/wayward/launcher/DiagnosticsLogger.java", "utf8");
const uploader = readFileSync("app/src/main/java/com/wayward/launcher/DiagnosticsBundleUploader.java", "utf8");

function methodBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing method: ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing next method: ${nextSignature}`);
  return source.slice(start, end);
}

const prompt = methodBody(main, "private void shareDiagnosticsZip(){", "private void uploadDiagnosticsZipAfterConsent(){");
assert.match(prompt, /setNegativeButton\("취소"/);
assert.match(prompt, /setPositiveButton\("동의하고 전송"/);
assert.match(prompt, /setOnCancelListener/);
assert.match(prompt, /diagnosticsConsentDialogShowing/);
assert.doesNotMatch(prompt, /DiagnosticsBundleExporter\.create\(/);
assert.doesNotMatch(prompt, /DiagnosticsBundleUploader\.upload\(/);
assert.doesNotMatch(prompt, /findPendingArchive\(/);

const confirmed = methodBody(main, "private void uploadDiagnosticsZipAfterConsent(){", "private void showOfficialUpdateDialog(");
assert.match(confirmed, /findPendingArchive\(this\)/);
assert.match(confirmed, /DiagnosticsBundleExporter\.create\(this\)/);
assert.match(confirmed, /DiagnosticsBundleUploader\.upload\(this/);
assert.match(confirmed, /DiagnosticsBundleUploader\.isUploading\(\)/);

function javaFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? javaFiles(path) : entry.isFile() && path.endsWith(".java") ? [path] : [];
  });
}
const implicitUploads = javaFiles("app/src").flatMap(path =>
  readFileSync(path, "utf8").includes("DiagnosticsUploader.uploadPending(") ? [path] : []);
assert.deepEqual(implicitUploads, []);
assert.doesNotMatch(main, /DiagnosticsUploader\.uploadPending\(/);
assert.doesNotMatch(logger, /DiagnosticsUploader\.uploadPending\(/);
assert.match(uploader, /new AtomicBoolean\(false\)/);
assert.match(uploader, /BUSY\.compareAndSet\(false, true\)/);
assert.match(uploader, /https:\/\/wayward-diagnostics-ingest\.trpgengine\.workers\.dev/);
assert.match(uploader, /BASE_URL \+ "\/v1\/ticket"/);
assert.match(uploader, /BASE_URL \+ uploadPath/);

console.log("PASS: cancel path performs no archive creation or network upload");
console.log("PASS: confirmed path creates/reuses one archive and uses the existing Cloudflare upload contract");
console.log("PASS: implicit Vercel diagnostics upload is disabled and duplicate uploads are guarded");
