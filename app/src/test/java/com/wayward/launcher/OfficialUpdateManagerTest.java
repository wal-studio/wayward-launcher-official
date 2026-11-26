package com.wayward.launcher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.regex.Pattern;

public final class OfficialUpdateManagerTest {
    private static Object invoke(String name, Class<?>[] parameterTypes, Object... args) throws Exception {
        Class<?> type = Class.forName("com.wayward.launcher.OfficialUpdateManager");
        Method method = type.getDeclaredMethod(name, parameterTypes);
        method.setAccessible(true);
        return method.invoke(null, args);
    }

    @Test
    public void sha256DigestRequiresExactly64HexCharacters() throws Exception {
        String hash = "a".repeat(64);
        assertEquals(hash, invoke("digestFromAsset", new Class<?>[]{String.class}, "sha256:" + hash));
        assertEquals(hash, invoke("digestFromAsset", new Class<?>[]{String.class}, "sha256:" + hash.toUpperCase()));
        assertEquals("", invoke("digestFromAsset", new Class<?>[]{String.class}, "sha512:" + hash));
        assertEquals("", invoke("digestFromAsset", new Class<?>[]{String.class}, "sha256:" + hash.substring(1)));
        assertEquals("", invoke("digestFromAsset", new Class<?>[]{String.class}, "sha256:" + hash + "00"));
        assertEquals("", invoke("digestFromAsset", new Class<?>[]{String.class}, (Object) null));
    }

    @Test
    public void checksumFileMatchesOnlyTheExpectedApkBasename() throws Exception {
        String hash = "0123456789abcdef".repeat(4);
        String apk = "WAL-Android-Launcher-1.0.0.apk";
        assertEquals(hash, invoke("findChecksum", new Class<?>[]{String.class, String.class},
                hash + "  " + apk, apk));
        assertEquals(hash, invoke("findChecksum", new Class<?>[]{String.class, String.class},
                hash + " *nested/path/" + apk, apk));
        assertEquals(hash, invoke("findChecksum", new Class<?>[]{String.class, String.class},
                hash + "  nested\\folder\\" + apk, apk));
        assertEquals("", invoke("findChecksum", new Class<?>[]{String.class, String.class},
                hash + "  WAL-Android-Launcher-1.0.1.apk", apk));
        assertEquals("", invoke("findChecksum", new Class<?>[]{String.class, String.class},
                "not-a-checksum", apk));
    }

    @Test
    public void releaseDownloadAllowlistRejectsLookalikeHostsAndHttp() throws Exception {
        assertTrue((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com/wal-studio/WAL-Official-Releases/releases/download/v1.0.0/WAL-Android-Launcher-1.0.0.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com/wal-studio/wayward-launcher-official/releases/download/v1.0.0/WAL-Android-Launcher-1.0.0.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "http://github.com/wal-studio/WAL-Official-Releases/releases/download/v1.0.0/file.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com/wal-studio/WAL-Official-Releases/blob/main/file.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com/wal-studio/WAL-Official-Releases/releases/tag/v1.0.0"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com.evil.example/wal-studio/WAL-Official-Releases/file.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class},
                "https://github.com/wal-studio/WAL-Official-Releases.evil/file.apk"));
        assertFalse((Boolean) invoke("isAllowedReleaseUrl", new Class<?>[]{String.class}, (Object) null));
    }

    @Test
    public void stableReleaseTagsRejectPrereleaseAndMalformedVersions() throws Exception {
        Class<?> type = Class.forName("com.wayward.launcher.OfficialUpdateManager");
        Field field = type.getDeclaredField("STABLE_TAG");
        field.setAccessible(true);
        Pattern pattern = (Pattern) field.get(null);
        assertTrue(pattern.matcher("v1.0.0").matches());
        assertTrue(pattern.matcher("2.14.3").matches());
        assertFalse(pattern.matcher("v01.0.0").matches());
        assertFalse(pattern.matcher("v0.1.0").matches());
        assertFalse(pattern.matcher("v1.01.0").matches());
        assertFalse(pattern.matcher("v1.0.01").matches());
        assertFalse(pattern.matcher("v1.0.0-beta.1").matches());
        assertFalse(pattern.matcher("latest").matches());
        assertFalse(pattern.matcher("v1.0").matches());
    }
    @Test
    public void dismissedVersionSuppressesOnlyTheSameOrOlderAutomaticNotice() {
        assertFalse(OfficialUpdateManager.shouldNotifyForVersion(2L, 2L));
        assertFalse(OfficialUpdateManager.shouldNotifyForVersion(1L, 2L));
        assertTrue(OfficialUpdateManager.shouldNotifyForVersion(3L, 2L));
        assertFalse(OfficialUpdateManager.shouldNotifyForVersion(0L, 0L));
    }

    @Test
    public void stableVersionCodeMatchesOfficialGradleFormula() {
        assertEquals(1L, OfficialUpdateManager.versionCodeFor("1.0.0"));
        assertEquals(2L, OfficialUpdateManager.versionCodeFor("1.0.1"));
        assertEquals(1001L, OfficialUpdateManager.versionCodeFor("1.1.0"));
        assertEquals(-1L, OfficialUpdateManager.versionCodeFor("1.0.1000"));
        assertEquals(-1L, OfficialUpdateManager.versionCodeFor("0.1.0"));
    }

    @Test
    public void draftPrereleaseAndNonStableReleasesAreNeverEligible() throws Exception {
        JSONObject release = releaseFixture();
        assertTrue(OfficialUpdateManager.isPublishedStableRelease(release));
        release.put("draft", true);
        assertFalse(OfficialUpdateManager.isPublishedStableRelease(release));
        release.put("draft", false).put("prerelease", true);
        assertFalse(OfficialUpdateManager.isPublishedStableRelease(release));
        release.put("prerelease", false).put("tag_name", "v1.0.1-rc.1");
        assertFalse(OfficialUpdateManager.isPublishedStableRelease(release));
    }

    @Test
    public void candidateRequiresNewerVersionAndPinnedReleaseManifestWithoutDownloadingApk() throws Exception {
        JSONObject release = releaseFixture();
        JSONObject manifest = manifestFixture();
        OfficialUpdateManager.Update candidate = OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official.wal", 1L, manifest);
        assertNotNull(candidate);
        assertNull(candidate.apkFile);
        assertEquals("1.0.1", candidate.versionName);
        assertEquals(2L, candidate.versionCode);
        assertEquals(1234L, candidate.apkBytes);
        assertEquals("0123456789abcdef".repeat(4), candidate.sha256);
        assertNull(OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official.wal", 2L, manifest));
        assertNull(OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official", 1L, manifest));
    }

    @Test
    public void candidateRejectsWrongSignerVersionHashAndDebugOnlyAssets() throws Exception {
        JSONObject release = releaseFixture();
        JSONObject manifest = manifestFixture();
        manifest.put("signerSha1", "0000000000000000000000000000000000000000");
        assertNull(OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official.wal", 1L, manifest));

        manifest = manifestFixture();
        manifest.put("versionCode", 109L);
        assertNull(OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official.wal", 1L, manifest));

        manifest = manifestFixture();
        manifest.put("sha256", "not-a-hash");
        assertNull(OfficialUpdateManager.candidateFromRelease(
                release, "com.wayward.launcher.official.wal", 1L, manifest));

        JSONObject debugOnly = releaseFixture();
        JSONArray assets = new JSONArray().put(new JSONObject()
                .put("name", "WAL-Android-Launcher-1.0.1-debug.apk")
                .put("browser_download_url", "https://github.com/wal-studio/WAL-Official-Releases/releases/download/v1.0.1/debug.apk")
                .put("size", 1234L));
        assets.put(new JSONObject().put("name", "WAL-Android-Launcher-1.0.1.release.json"));
        debugOnly.put("assets", assets);
        assertNull(OfficialUpdateManager.candidateFromRelease(
                debugOnly, "com.wayward.launcher.official.wal", 1L, manifestFixture()));
    }

    private static JSONObject releaseFixture() throws Exception {
        String hash = "0123456789abcdef".repeat(4);
        JSONArray assets = new JSONArray();
        assets.put(new JSONObject()
                .put("name", "WAL-Android-Launcher-1.0.1.apk")
                .put("browser_download_url", "https://github.com/wal-studio/WAL-Official-Releases/releases/download/v1.0.1/WAL-Android-Launcher-1.0.1.apk")
                .put("size", 1234L)
                .put("digest", "sha256:" + hash));
        assets.put(new JSONObject().put("name", "WAL-Android-Launcher-1.0.1.release.json"));
        return new JSONObject().put("draft", false).put("prerelease", false)
                .put("tag_name", "v1.0.1").put("assets", assets).put("body", "Stable update notes");
    }

    private static JSONObject manifestFixture() throws Exception {
        return new JSONObject()
                .put("packageName", "com.wayward.launcher.official.wal")
                .put("versionName", "1.0.1")
                .put("versionCode", 2L)
                .put("signerSha1", "D9BE7443EB247D27C958CC4250D7F5D1E078F740")
                .put("apkFile", "WAL-Android-Launcher-1.0.1.apk")
                .put("sizeBytes", 1234L)
                .put("sha256", "0123456789abcdef".repeat(4));
    }
}
