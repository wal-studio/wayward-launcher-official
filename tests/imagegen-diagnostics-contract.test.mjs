import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const root=process.cwd();
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const logger=read("app/src/main/java/com/wayward/launcher/DiagnosticsLogger.java");
const installer=read("app/src/main/java/com/wayward/launcher/ImageGenBackendInstaller.java");
const service=read("app/src/main/java/com/wayward/launcher/ImageGenService.java");
const main=read("app/src/main/java/com/wayward/launcher/MainActivity.java");
const exporter=read("app/src/main/java/com/wayward/launcher/DiagnosticsBundleExporter.java");
const uploader=read("app/src/main/java/com/wayward/launcher/DiagnosticsBundleUploader.java");
const manifest=read("app/src/main/AndroidManifest.xml");
const workflow=read(".github/workflows/android-product-validation-v1.3.yml");
test("installer failure is emitted from the actual install catch path with stage and target metadata",()=>{
 const method=installer.slice(installer.indexOf("static File install("),installer.indexOf("static boolean isValidInstalled("));
 assert.match(method,/catch\s*\(Throwable error\)/);
 assert.match(method,/DiagnosticsLogger\.error\(context,\s*"imagegen_backend_installer",\s*"imagegen_backend_install_failed"/);
 assert.match(method,/details\.put\("stage", stage\)/);
 assert.match(method,/installTargetRelativePath/);
 assert.match(method,/apkBackendManifestPresent/);
 assert.match(method,/installParentWritable/);
});
test("prepare and service dispatch failures are connected to launcher and service call paths",()=>{
 assert.match(main,/imagegen_backend_prepare_failed/);
 const start=main.slice(main.indexOf("private void startImageGenService(File backend,String version,String launchMode,String comfyUrl)"),main.indexOf("private void stopImageGenServer()"));
 assert.match(start,/imagegen_service_start_requested/);
 assert.match(start,/imagegen_service_start_failed/);
 assert.match(service,/imagegen_service_start_received/);
 assert.match(service,/imagegen_service_start_failed/);
 assert.match(service,/imagegen_runtime_start_failed/);
});
test("full exception stack journal is bounded, redacted and included in existing ZIP",()=>{
 assert.match(logger,/appendExceptionStack\(context, component, name, error, stack\)/);
 assert.match(logger,/STACK_ACTIVE = "exception-stacks\.ndjson"/);
 assert.match(logger,/STACK_PREVIOUS = "exception-stacks\.previous\.ndjson"/);
 assert.match(logger,/record\.put\("stack", stack\)/);
 assert.match(logger,/MAX_STACK_CHARS = 160000/);
 assert.match(logger,/out\.length\(\) > MAX_STACK_CHARS/);
 assert.match(exporter,/addFile\(zip, "exception-stacks\.ndjson"/);
 assert.match(exporter,/addFile\(zip, "exception-stacks\.previous\.ndjson"/);
});
test("ZIP metadata includes versionCode, Android SDK, APK backend assets and install target state",()=>{
 assert.match(exporter,/meta\.put\("versionCode", versionCode\)/);
 assert.match(exporter,/meta\.put\("androidSdk", Build\.VERSION\.SDK_INT\)/);
 assert.match(exporter,/apkBackendAssetPresent/);
 assert.match(exporter,/apkBackendManifestPresent/);
 assert.match(exporter,/backendInstallTargetRelativePath/);
 assert.match(exporter,/backendInstallParentWritable/);
 assert.match(exporter,/backendInstalledValid/);
 assert.match(workflow,/aapt list \$apk/);
 assert.match(workflow,/assets\/imagegen-backend\/launcher-bundle\.json/);
 assert.match(workflow,/assets\/imagegen-backend\/wayward-imagegen\/package\.json/);
});
test("existing Cloudflare ZIP upload endpoint remains unchanged",()=>{
 assert.match(uploader,/https:\/\/wayward-diagnostics-ingest\.trpgengine\.workers\.dev/);
 assert.match(uploader,/BASE_URL \+ "\/v1\/ticket"/);
 assert.match(uploader,/BASE_URL \+ uploadPath/);
 assert.match(uploader,/Content-Type", "application\/zip"/);
 assert.match(exporter,/launcher\.ndjson/);
 assert.match(exporter,/imagegen\/startup\.log/);
});
test("CAPTCHA test-only handoff is absent from preserved pre-CAPTCHA baseline",()=>{
 assert.equal(fs.existsSync(path.join(root,"app/src/main/java/com/wayward/launcher/NovelAiCaptchaActivity.java")),false);
 assert.doesNotMatch(main,/NovelAiCaptchaActivity/);
 assert.doesNotMatch(read("app/src/main/java/com/wayward/launcher/ImageGenProxy.java"),/NovelAiCaptchaActivity/);
 assert.doesNotMatch(manifest,/NovelAiCaptchaActivity/);
});
