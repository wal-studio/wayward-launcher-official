package com.wayward.launcher;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class OfficialUpdateManager {
    private static final String TAG = "WALOfficialUpdater";
    private static final String RELEASES_API =
            "https://api.github.com/repos/wal-studio/WAL-Official-Releases/releases?per_page=30";
    private static final String SIGNER_SHA1 = "D9BE7443EB247D27C958CC4250D7F5D1E078F740";
    private static final String PREFS = "wal_official_update_state";
    private static final String LAST_CHECK = "last_check_ms";
    private static final String PENDING_APK = "pending_apk_path";
    private static final String PENDING_HASH = "pending_apk_sha256";
    private static final String DISMISSED_VERSION_CODE = "dismissed_version_code";
    private static final long CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long MAX_APK_BYTES = 300L * 1024L * 1024L;
    private static final Pattern STABLE_TAG = Pattern.compile("^v?([1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$");
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean CHECKING = new AtomicBoolean(false);
    private static final AtomicBoolean DOWNLOADING = new AtomicBoolean(false);

    private OfficialUpdateManager() {}

    public interface Listener { void onUpdateAvailable(Update update); }

    public static final class Update {
        public final File apkFile;
        public final String apkUrl;
        public final String apkName;
        public final long apkBytes;
        public final String versionName;
        public final long versionCode;
        public final String sha256;
        public final String notes;

        Update(String url, String fileName, long bytes, String name, long code, String hash, String body) {
            apkFile = null;
            apkUrl = url;
            apkName = fileName;
            apkBytes = bytes;
            versionName = name;
            versionCode = code;
            sha256 = hash;
            notes = body == null ? "" : body;
        }

        Update(File file, String name, long code, String hash, String body) {
            apkFile = file;
            apkUrl = "";
            apkName = file == null ? "" : file.getName();
            apkBytes = file == null ? 0L : file.length();
            versionName = name;
            versionCode = code;
            sha256 = hash;
            notes = body == null ? "" : body;
        }
    }

    public static void checkForUpdate(Context context, Listener listener) {
        if (context == null || !BuildConfig.WAL_OFFICIAL || !CHECKING.compareAndSet(false, true)) return;
        Context app = context.getApplicationContext();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (System.currentTimeMillis() - prefs.getLong(LAST_CHECK, 0L) < CHECK_INTERVAL_MS) {
            CHECKING.set(false);
            return;
        }
        EXECUTOR.execute(() -> {
            try {
                Update update = findLatest(app);
                prefs.edit().putLong(LAST_CHECK, System.currentTimeMillis()).apply();
                long dismissed = prefs.getLong(DISMISSED_VERSION_CODE, 0L);
                if (update != null && shouldNotifyForVersion(update.versionCode, dismissed) && listener != null) {
                    new Handler(Looper.getMainLooper()).post(() -> listener.onUpdateAvailable(update));
                }
            } catch (Exception error) {
                Log.w(TAG, "Stable update check failed", error);
                prefs.edit().putLong(LAST_CHECK, System.currentTimeMillis()).apply();
            } finally {
                CHECKING.set(false);
            }
        });
    }

    public static void dismiss(Context context, Update update) {
        if (context == null || update == null) return;
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(DISMISSED_VERSION_CODE, update.versionCode).apply();
    }

    public interface CheckListener { void onResult(Update update, Exception error); }

    public static void checkForUpdateNow(Context context, CheckListener listener) {
        if (context == null || !BuildConfig.WAL_OFFICIAL || !CHECKING.compareAndSet(false, true)) return;
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            Update update = null;
            Exception failure = null;
            try {
                update = findLatest(app);
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putLong(LAST_CHECK, System.currentTimeMillis()).apply();
            } catch (Exception error) {
                failure = error;
                Log.w(TAG, "Manual stable update check failed", error);
            } finally {
                CHECKING.set(false);
            }
            final Update result = update;
            final Exception error = failure;
            if (listener != null) new Handler(Looper.getMainLooper()).post(() -> listener.onResult(result, error));
        });
    }

    private static Update findLatest(Context context) throws Exception {
        return findLatestFromApi(context, RELEASES_API);
    }

    private static Update findLatestFromApi(Context context, String releasesApi) throws Exception {
        JSONArray releases = new JSONArray(readUrl(releasesApi, 2 * 1024 * 1024));
        PackageInfo installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        long installedCode = installed.getLongVersionCode();
        Update latest = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.getJSONObject(i);
            if (!isPublishedStableRelease(release)) continue;
            Matcher tag = STABLE_TAG.matcher(release.optString("tag_name", ""));
            if (!tag.matches()) continue;
            String version = tag.group(1) + "." + tag.group(2) + "." + tag.group(3);
            long candidateCode = versionCodeFor(version);
            if (candidateCode <= installedCode) continue;

            String manifestName = "WAL-Android-Launcher-" + version + ".release.json";
            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) continue;
            JSONObject manifestAsset = null;
            int manifestCount = 0;
            for (int j = 0; j < assets.length(); j++) {
                JSONObject asset = assets.optJSONObject(j);
                if (asset != null && manifestName.equals(asset.optString("name", ""))) {
                    manifestAsset = asset;
                    manifestCount++;
                }
            }
            if (manifestCount != 1 || manifestAsset == null) continue;
            String manifestUrl = manifestAsset.optString("browser_download_url", "");
            if (!isAllowedReleaseUrl(manifestUrl)
                    || !new URL(manifestUrl).getPath().endsWith("/" + manifestName)) continue;

            try {
                JSONObject manifest = new JSONObject(readUrl(manifestUrl, 16 * 1024));
                Update candidate = candidateFromRelease(release, context.getPackageName(),
                        installedCode, manifest);
                if (candidate != null && (latest == null || candidate.versionCode > latest.versionCode)) {
                    latest = candidate;
                }
            } catch (SecurityException invalidRelease) {
                Log.w(TAG, "Ignoring incompatible stable release " + version, invalidRelease);
            } catch (org.json.JSONException | IllegalStateException invalidManifest) {
                Log.w(TAG, "Ignoring malformed stable release manifest " + version, invalidManifest);
            }
        }
        return latest;
    }

    static boolean isPublishedStableRelease(JSONObject release) {
        if (release == null || release.optBoolean("draft", true)
                || release.optBoolean("prerelease", true)) return false;
        return STABLE_TAG.matcher(release.optString("tag_name", "")).matches();
    }

    static boolean shouldNotifyForVersion(long candidateVersionCode, long dismissedVersionCode) {
        return candidateVersionCode > 0L && candidateVersionCode > dismissedVersionCode;
    }

    static long versionCodeFor(String version) {
        Matcher tag = STABLE_TAG.matcher(version == null ? "" : version);
        if (!tag.matches()) return -1L;
        try {
            long major = Long.parseLong(tag.group(1));
            long minor = Long.parseLong(tag.group(2));
            long patch = Long.parseLong(tag.group(3));
            if (major < 1L || minor >= 1000L || patch >= 1000L) return -1L;
            long code = 1L + (major - 1L) * 1_000_000L + minor * 1_000L + patch;
            return code <= 2_100_000_000L ? code : -1L;
        } catch (NumberFormatException error) {
            return -1L;
        }
    }

    static Update candidateFromRelease(JSONObject release, String installedPackage,
            long installedVersionCode, JSONObject manifest) throws Exception {
        if (!isPublishedStableRelease(release)) return null;
        Matcher tag = STABLE_TAG.matcher(release.optString("tag_name", ""));
        if (!tag.matches()) return null;
        String version = tag.group(1) + "." + tag.group(2) + "." + tag.group(3);
        long versionCode = versionCodeFor(version);
        if (versionCode <= installedVersionCode) return null;

        String apkName = "WAL-Android-Launcher-" + version + ".apk";
        String manifestName = "WAL-Android-Launcher-" + version + ".release.json";
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;
        JSONObject apkAsset = null;
        int apkCount = 0;
        int manifestCount = 0;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null) continue;
            String name = asset.optString("name", "");
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".apk") && !lower.contains("debug")) {
                apkAsset = asset;
                apkCount++;
            }
            if (manifestName.equals(name)) manifestCount++;
        }
        if (apkCount != 1 || apkAsset == null || manifestCount != 1) return null;
        if (!apkName.equals(apkAsset.optString("name", ""))) return null;

        String apkUrl = apkAsset.optString("browser_download_url", "");
        long apkBytes = apkAsset.optLong("size", 0L);
        if (!isAllowedReleaseUrl(apkUrl) || !new URL(apkUrl).getPath().endsWith("/" + apkName)
                || !"uploaded".equalsIgnoreCase(apkAsset.optString("state", "uploaded"))
                || apkBytes <= 0L || apkBytes > MAX_APK_BYTES) return null;
        if (!manifestMatches(manifest, installedPackage, version, versionCode, apkName, apkBytes)) return null;

        String manifestHash = manifest.optString("sha256", "").toLowerCase(Locale.ROOT);
        String apiDigest = apkAsset.optString("digest", "");
        if (!apiDigest.isEmpty()) {
            String assetHash = digestFromAsset(apiDigest);
            if (assetHash.isEmpty() || !assetHash.equals(manifestHash)) return null;
        }
        return new Update(apkUrl, apkName, apkBytes, version, versionCode,
                manifestHash, release.optString("body", ""));
    }

    static boolean manifestMatches(JSONObject manifest, String packageName, String versionName,
            long versionCode, String apkName, long apkBytes) {
        if (manifest == null) return false;
        String signer = manifest.optString("signerSha1", "").replace(":", "")
                .toUpperCase(Locale.ROOT);
        String hash = manifest.optString("sha256", "").toLowerCase(Locale.ROOT);
        return packageName != null && packageName.equals(manifest.optString("packageName", ""))
                && versionName.equals(manifest.optString("versionName", ""))
                && versionCode == manifest.optLong("versionCode", -1L)
                && apkName.equals(manifest.optString("apkFile", ""))
                && apkBytes == manifest.optLong("sizeBytes", -1L)
                && SIGNER_SHA1.equals(signer)
                && hash.matches("[0-9a-f]{64}");
    }

    private static boolean isAllowedReleaseUrl(String value) {
        if (value == null) return false;
        try {
            URL url = new URL(value);
            return "https".equalsIgnoreCase(url.getProtocol())
                    && "github.com".equalsIgnoreCase(url.getHost())
                    && url.getPath().startsWith(
                            "/wal-studio/WAL-Official-Releases/releases/download/");
        } catch (Exception ignored) {
            return false;
        }
    }

    public static void install(Context context, Update update) {
        if (context == null || update == null || !BuildConfig.WAL_OFFICIAL || update.apkFile != null) return;
        if (!isAllowedReleaseUrl(update.apkUrl)) {
            Toast.makeText(context, "정식 릴리즈 다운로드 주소가 올바르지 않습니다.", Toast.LENGTH_LONG).show();
            return;
        }
        if (!DOWNLOADING.compareAndSet(false, true)) {
            Toast.makeText(context, "업데이트 파일을 이미 준비 중입니다.", Toast.LENGTH_SHORT).show();
            return;
        }
        Context app = context.getApplicationContext();
        Toast.makeText(context, "정식 업데이트 파일 다운로드 및 검증 중…", Toast.LENGTH_SHORT).show();
        EXECUTOR.execute(() -> {
            File apk = null;
            try {
                File directory = new File(app.getCacheDir(), "updates");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IllegalStateException("Cannot create update cache.");
                }
                apk = new File(directory, update.apkName);
                download(update.apkUrl, apk, update.apkBytes);
                Update verified = verifyApk(app, apk, update.sha256,
                        update.versionName, update.versionCode, update.notes);
                PackageInfo installed = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
                if (verified.versionCode <= installed.getLongVersionCode()) {
                    throw new SecurityException("Downloaded update is not newer than the installed app.");
                }
                SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                prefs.edit().putString(PENDING_APK, apk.getAbsolutePath())
                        .putString(PENDING_HASH, update.sha256).apply();
                new Handler(Looper.getMainLooper()).post(() -> {
                    DOWNLOADING.set(false);
                    Toast.makeText(app, "APK 검증 완료. Android 설치 확인을 진행합니다.",
                            Toast.LENGTH_LONG).show();
                    requestInstallPermissionOrContinue(app);
                });
            } catch (Exception error) {
                if (apk != null && apk.isFile()) apk.delete();
                Log.w(TAG, "Explicitly requested update download/verification failed", error);
                new Handler(Looper.getMainLooper()).post(() -> {
                    DOWNLOADING.set(false);
                    Toast.makeText(app, "업데이트 다운로드/검증 실패: " + safeMessage(error),
                            Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private static void requestInstallPermissionOrContinue(Context app) {
        if (Build.VERSION.SDK_INT >= 26 && !app.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + app.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                app.startActivity(settings);
                Toast.makeText(app, "이 앱의 설치 권한을 허용한 뒤 런처로 돌아오세요.",
                        Toast.LENGTH_LONG).show();
            } catch (Exception error) {
                Toast.makeText(app, "앱 설치 권한 설정을 열 수 없습니다.", Toast.LENGTH_LONG).show();
                Log.e(TAG, "Cannot open install permission settings", error);
            }
            return;
        }
        installPendingIfAllowed(app);
    }

    public static void installPendingIfAllowed(Context context) {
        if (context == null || !BuildConfig.WAL_OFFICIAL) return;
        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) return;
        Context app = context.getApplicationContext();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String path = prefs.getString(PENDING_APK, null);
        String hash = prefs.getString(PENDING_HASH, null);
        if (path == null || hash == null) return;
        try {
            File apk = new File(path);
            Update verified = verifyApk(app, apk, hash, "");
            PackageInfo installed = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            if (verified.versionCode <= installed.getLongVersionCode()) {
                clearPending(prefs);
                return;
            }
            Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".diagnostics", apk);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(uri, "application/vnd.android.package-archive");
            installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            clearPending(prefs);
            app.startActivity(installer);
        } catch (Exception error) {
            clearPending(prefs);
            Log.e(TAG, "Verified APK could not be passed to Android installer", error);
            Toast.makeText(app, "업데이트 설치 준비에 실패했습니다: " + safeMessage(error), Toast.LENGTH_LONG).show();
        }
    }

    private static void clearPending(SharedPreferences prefs) {
        prefs.edit().remove(PENDING_APK).remove(PENDING_HASH).apply();
    }

    private static Update verifyApk(Context context, File apk, String expectedHash, String notes) throws Exception {
        return verifyApk(context, apk, expectedHash, null, -1L, notes);
    }

    private static Update verifyApk(Context context, File apk, String expectedHash,
            String expectedVersionName, long expectedVersionCode, String notes) throws Exception {
        if (!apk.isFile() || apk.length() <= 0 || apk.length() > MAX_APK_BYTES) {
            throw new SecurityException("Downloaded APK is missing or has an invalid size.");
        }
        String actualHash = sha256(apk);
        if (!actualHash.equalsIgnoreCase(expectedHash)) throw new SecurityException("APK SHA-256 mismatch.");
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(
                apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (info == null || !context.getPackageName().equals(info.packageName)) {
            throw new SecurityException("APK package ID does not match this Official app.");
        }
        if (expectedVersionName != null && !expectedVersionName.equals(info.versionName)) {
            throw new SecurityException("APK version name does not match its stable release tag.");
        }
        if (expectedVersionCode > 0L && expectedVersionCode != info.getLongVersionCode()) {
            throw new SecurityException("APK version code does not match its stable release manifest.");
        }
        if (info.signingInfo == null) throw new SecurityException("APK signing identity is unavailable.");
        Signature[] signers = info.signingInfo.getApkContentsSigners();
        if (signers == null || signers.length != 1 || !SIGNER_SHA1.equals(sha1(signers[0].toByteArray()))) {
            throw new SecurityException("APK signer does not match the registered Official certificate.");
        }
        return new Update(apk, info.versionName, info.getLongVersionCode(), actualHash, notes);
    }

    private static String digestFromAsset(String digest) {
        if (digest == null || !digest.startsWith("sha256:")) return "";
        String value = digest.substring(7).trim().toLowerCase(Locale.ROOT);
        return value.matches("[0-9a-f]{64}") ? value : "";
    }

    private static String findChecksum(String text, String apkName) {
        if (text == null) return "";
        String onlyHash = text.trim();
        if (onlyHash.matches("[0-9a-fA-F]{64}")) return onlyHash.toLowerCase(Locale.ROOT);
        for (String line : text.split("\\r?\\n")) {
            Matcher m = Pattern.compile("^([0-9a-fA-F]{64})\\s+\\*?(.+)$").matcher(line.trim());
            if (!m.matches()) continue;
            String listed = m.group(2).trim().replace('\\', '/');
            int slash = listed.lastIndexOf('/');
            if (slash >= 0) listed = listed.substring(slash + 1);
            if (apkName.equals(listed)) return m.group(1).toLowerCase(Locale.ROOT);
        }
        return "";
    }

    private static void download(String url, File target, long expectedBytes) throws Exception {
        if (!isAllowedReleaseUrl(url)) throw new SecurityException("APK URL is not an approved official release asset.");
        HttpURLConnection c = open(url);
        try {
            int status = c.getResponseCode();
            if (status != 200) throw new IllegalStateException("APK download HTTP " + status);
            URL finalUrl = c.getURL();
            String host = finalUrl.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equalsIgnoreCase(finalUrl.getProtocol())
                    || !("github.com".equals(host) || "release-assets.githubusercontent.com".equals(host)
                    || "objects.githubusercontent.com".equals(host))) {
                throw new SecurityException("APK download redirected outside approved HTTPS GitHub asset hosts.");
            }
            long contentLength = c.getContentLengthLong();
            if (contentLength > MAX_APK_BYTES
                    || (contentLength > 0L && expectedBytes > 0L && contentLength != expectedBytes)
                    || (contentLength <= 0L && expectedBytes <= 0L)) {
                throw new SecurityException("APK content length does not match the release asset metadata.");
            }
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                long total = 0L;
                int n;
                while ((n = in.read(buffer)) != -1) {
                    total += n;
                    if (total > MAX_APK_BYTES || (expectedBytes > 0L && total > expectedBytes)) {
                        throw new SecurityException("APK exceeded its declared size.");
                    }
                    out.write(buffer, 0, n);
                }
                if (expectedBytes > 0L && total != expectedBytes) {
                    throw new SecurityException("APK download was truncated or changed size.");
                }
                if (contentLength > 0L && total != contentLength) {
                    throw new SecurityException("APK download was truncated or changed size.");
                }
                out.flush();
            }
        } finally { c.disconnect(); }
    }

    private static String readUrl(String url, int maxBytes) throws Exception {
        if (url == null || !url.startsWith("https://")) throw new SecurityException("HTTPS required.");
        HttpURLConnection c = open(url);
        try {
            int status = c.getResponseCode();
            if (status != 200) throw new IllegalStateException("Update metadata HTTP " + status);
            if (!"https".equalsIgnoreCase(c.getURL().getProtocol())) {
                throw new SecurityException("Update metadata redirected outside HTTPS.");
            }
            try (InputStream in = c.getInputStream();
                 java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int total = 0;
                int n;
                while ((n = in.read(buffer)) != -1) {
                    total += n;
                    if (total > maxBytes) throw new SecurityException("Update metadata too large.");
                    out.write(buffer, 0, n);
                }
                return out.toString("UTF-8");
            }
        } finally { c.disconnect(); }
    }

    private static HttpURLConnection open(String url) throws Exception {
        if (url == null || !url.startsWith("https://")) throw new SecurityException("HTTPS required.");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "WAL-Android-Launcher-Updater");
        c.setRequestProperty("Accept", "application/vnd.github+json");
        return c;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) md.update(buffer, 0, n);
        }
        return hex(md.digest());
    }

    private static String sha1(byte[] cert) throws Exception {
        return hex(MessageDigest.getInstance("SHA-1").digest(cert));
    }

    private static String hex(byte[] data) {
        StringBuilder out = new StringBuilder(data.length * 2);
        for (byte b : data) out.append(String.format(Locale.ROOT, "%02X", b));
        return out.toString();
    }

    private static String safeMessage(Exception e) {
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }
}
