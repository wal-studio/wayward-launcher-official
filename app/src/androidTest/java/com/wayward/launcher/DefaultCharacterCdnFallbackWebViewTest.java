package com.wayward.launcher;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URL;
import java.security.Principal;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLPeerUnverifiedException;
import java.io.BufferedReader;
import java.io.FileReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public final class DefaultCharacterCdnFallbackWebViewTest {
    private static final String PREFS = "wayward_launcher";
    private static final String IMAGE_MODE_KEY = "image_server_mode";
    private static final String MOD_ID = "wal-cdn-fallback-test";
    private static final java.util.concurrent.atomic.AtomicInteger CDN_REQUESTS = new java.util.concurrent.atomic.AtomicInteger();
    private static final String PNG_BASE64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

    @Test
    public void cdnFailureFallsBackToSafAndZipImagePacksInsideMainActivityWebView() throws Exception {
        final android.app.Instrumentation instrumentation =
                InstrumentationRegistry.getInstrumentation();
        final Context context = instrumentation.getTargetContext();
        final Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        final MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        assertNotNull(activity);

        final SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final String previousMode = preferences.getString(IMAGE_MODE_KEY, null);
        final ZipModStore store = (ZipModStore) getField(activity, "zipMods");
        store.uninstall(MOD_ID);
        final File stagedZip = store.temporaryFile(".zip");
        installTestImagePack(store, stagedZip);

        final String profileId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        CdnFallbackTestDocumentsProvider.reset();
        final Uri treeUri = DocumentsContract.buildTreeDocumentUri(
                CdnFallbackTestDocumentsProvider.AUTHORITY,
                CdnFallbackTestDocumentsProvider.ROOT_ID);
        final String successHtml = "<!doctype html><html><body>"
                + "<img id='cdnSuccess' src='https://art.sintention.com/images/illustrious/situation/info/pippa/wal-cdn-fallback-success.png'>"
                + "</body></html>";
        final String fallbackHtml = "<!doctype html><html><body>"
                + "<img id='safFallback' src='https://art.sintention.com/images/illustrious/situation/info/pippa/wal-cdn-fallback-saf.png'>"
                + "<img id='zipFallback' src='https://art.sintention.com/images/illustrious/situation/info/mara/wal-cdn-fallback-zip.png'>"
                + "<img id='otherHost' src='https://not-allowed.invalid/images/illustrious/situation/info/pippa/wal-cdn-fallback-other-host.png'>"
                + "<img id='missingLocal' src='https://art.sintention.com/images/illustrious/situation/info/elena/wal-cdn-fallback-missing.png'>"
                + "</body></html>";
        final String[] originHolder = new String[1];
        final WebView[] webHolder = new WebView[1];

        CDN_REQUESTS.set(0);
        MainActivity.setDefaultCharacterCdnConnectionFactoryForTesting(url -> {
            CDN_REQUESTS.incrementAndGet();
            if (url.getPath().endsWith("wal-cdn-fallback-success.png")) {
                return new FakeConnection(url, 200, "image/png", Base64.decode(PNG_BASE64, Base64.DEFAULT));
            }
            return new FakeConnection(url, 404, "text/plain", new byte[0]);
        });
        preferences.edit().putString(IMAGE_MODE_KEY, "image-packs-only").commit();
        instrumentation.runOnMainSync(() -> {
            try {
                setField(activity, "activeProfileId", profileId);
                setField(activity, "treeUri", treeUri);
                setField(activity, "tree", createSafTree(activity, treeUri));
                setField(activity, "imagePackDiagnosticSessionId", "cdn-fallback-webview-test");
                Object oldValue = getField(activity, "web");
                if (oldValue instanceof WebView) {
                    WebView oldWeb = (WebView) oldValue;
                    ViewParent parent = oldWeb.getParent();
                    if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(oldWeb);
                    oldWeb.destroy();
                    setField(activity, "web", null);
                }
                Method createWeb = MainActivity.class.getDeclaredMethod("createWeb");
                createWeb.setAccessible(true);
                createWeb.invoke(activity);
                WebView web = (WebView) getField(activity, "web");
                webHolder[0] = web;
                web.setVisibility(View.VISIBLE);
                Method sessionOrigin = MainActivity.class.getDeclaredMethod("sessionOrigin", String.class);
                sessionOrigin.setAccessible(true);
                String origin = (String) sessionOrigin.invoke(activity, profileId);
                originHolder[0] = origin;
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });

        try {
            WebView web = webHolder[0];
            assertNotNull(web);
            CdnFallbackTestDocumentsProvider.resetCounters();
            CDN_REQUESTS.set(0);
            instrumentation.runOnMainSync(() -> web.loadDataWithBaseURL(
                    originHolder[0] + "/game/cdn-cdn-success-test.html",
                    successHtml, "text/html", "UTF-8", null));
            assertEquals("1", waitForNaturalWidth(instrumentation, web, "cdnSuccess", 1, 25000));
            assertEquals("CDN success must not query local SAF", 0,
                    CdnFallbackTestDocumentsProvider.queryCount());
            assertEquals("CDN success must not open local SAF", 0,
                    CdnFallbackTestDocumentsProvider.openCount());
            assertEquals("CDN success must issue one original request", 1, CDN_REQUESTS.get());
            assertTrue("successful CDN image must be recorded", waitForCdnEvent(context,
                    "default_character_cdn_loaded", "wal-cdn-fallback-success.png", 10000));

            CdnFallbackTestDocumentsProvider.resetCounters();
            CDN_REQUESTS.set(0);
            instrumentation.runOnMainSync(() -> web.loadDataWithBaseURL(
                    originHolder[0] + "/game/cdn-fallback-test.html",
                    fallbackHtml, "text/html", "UTF-8", null));
            assertEquals("1", waitForNaturalWidth(instrumentation, web, "safFallback", 1, 25000));
            assertEquals("1", waitForNaturalWidth(instrumentation, web, "zipFallback", 1, 25000));
            assertTrue("CDN 404/failure must be recorded before SAF fallback",
                    waitForCdnFailureEvent(context, "wal-cdn-fallback-saf.png", 10000));
            assertTrue("CDN 404/failure must be recorded before ZIP fallback",
                    waitForCdnFailureEvent(context, "wal-cdn-fallback-zip.png", 10000));
            assertEquals("0", waitForNaturalWidth(instrumentation, web, "otherHost", 0, 10000));
            assertEquals("0", waitForNaturalWidth(instrumentation, web, "missingLocal", 0, 25000));
            assertTrue("SAF fallback must query and open the local provider",
                    CdnFallbackTestDocumentsProvider.queryCount() >= 2
                            && CdnFallbackTestDocumentsProvider.openCount() >= 1);
            assertTrue("CDN failure routes must issue original requests", CDN_REQUESTS.get() >= 3);
        } finally {
            MainActivity.setDefaultCharacterCdnConnectionFactoryForTesting(null);
            store.uninstall(MOD_ID);
            if (previousMode == null) preferences.edit().remove(IMAGE_MODE_KEY).commit();
            else preferences.edit().putString(IMAGE_MODE_KEY, previousMode).commit();
            instrumentation.runOnMainSync(() -> {
                try {
                    WebView web = webHolder[0];
                    if (web != null) {
                        ViewParent parent = web.getParent();
                        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(web);
                        web.destroy();
                        setField(activity, "web", null);
                    }
                    activity.finish();
                } catch (Exception ignored) {}
            });
        }
    }

    private static String staticStringField(String name) throws Exception {
        java.lang.reflect.Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static String evaluateJsString(android.app.Instrumentation instrumentation,
                                           WebView web, String script) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> raw = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(script, value -> {
            raw.set(value);
            latch.countDown();
        }));
        if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("WebView result evaluation timed out");
        String value = raw.get();
        if (value == null || "null".equals(value)) return null;
        try {
            return new org.json.JSONArray("[" + value + "]").getString(0);
        } catch (Exception ignored) {
            return value;
        }
    }

    private static boolean waitForCdnEvent(Context context, String event, String fileName, long timeoutMs)
            throws Exception {
        File log = new File(context.getFilesDir(), "diagnostics/launcher.ndjson");
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (log.isFile()) {
                StringBuilder contents = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new FileReader(log))) {
                    String line;
                    while ((line = reader.readLine()) != null) contents.append(line).append('\n');
                }
                if (contents.indexOf(event) >= 0 && contents.indexOf(fileName) >= 0) return true;
            }
            android.os.SystemClock.sleep(200);
        }
        return false;
    }

    private static boolean waitForCdnFailureEvent(Context context, String fileName, long timeoutMs)
            throws Exception {
        File log = new File(context.getFilesDir(), "diagnostics/launcher.ndjson");
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (log.isFile()) {
                StringBuilder contents = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new FileReader(log))) {
                    String line;
                    while ((line = reader.readLine()) != null) contents.append(line).append('\n');
                }
                if (contents.indexOf("default_character_cdn_failed") >= 0
                        && contents.indexOf(fileName) >= 0) return true;
            }
            android.os.SystemClock.sleep(200);
        }
        return false;
    }

    private static Object createSafTree(MainActivity activity, Uri treeUri) throws Exception {
        Class<?> safTree = null;
        for (Class<?> nested : MainActivity.class.getDeclaredClasses()) {
            if ("SafTree".equals(nested.getSimpleName())) { safTree = nested; break; }
        }
        if (safTree == null) throw new AssertionError("MainActivity.SafTree is missing");
        java.lang.reflect.Constructor<?> constructor =
                safTree.getDeclaredConstructor(MainActivity.class, Uri.class);
        constructor.setAccessible(true);
        return constructor.newInstance(activity, treeUri);
    }

    private static void installTestImagePack(ZipModStore store, File stagedZip) throws Exception {
        byte[] png = Base64.decode(PNG_BASE64, Base64.DEFAULT);
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(stagedZip))) {
            put(zip, "mod.js", ("WML.define({ id: '" + MOD_ID + "' });").getBytes(StandardCharsets.UTF_8));
            put(zip, "images/illustrious/situation/info/mara/wal-cdn-fallback-zip.png", png);
        }
        assertTrue(store.install(stagedZip));
    }

    private static void put(ZipOutputStream zip, String name, byte[] bytes) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(bytes);
        zip.closeEntry();
    }

    private static String waitForNaturalWidth(android.app.Instrumentation instrumentation,
                                              WebView web, String id, int expected,
                                              long timeoutMs) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        String last = "-1";
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            final CountDownLatch latch = new CountDownLatch(1);
            final AtomicReference<String> result = new AtomicReference<>("-1");
            instrumentation.runOnMainSync(() -> web.evaluateJavascript(
                    "(function(){var i=document.getElementById('" + id + "');return i&&i.complete?String(i.naturalWidth):'-1';})()",
                    value -> { result.set(value == null ? "-1" : value.replace("\"", "")); latch.countDown(); }));
            if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("WebView JS evaluation timed out: " + id);
            last = result.get();
            if (Integer.toString(expected).equals(last)) return last;
            android.os.SystemClock.sleep(250);
        }
        throw new AssertionError("Unexpected WebView image width for " + id + ": " + last);
    }

    private static final class FakeConnection extends HttpsURLConnection {
        private final int status;
        private final String mime;
        private final byte[] bytes;
        FakeConnection(URL url, int status, String mime, byte[] bytes) {
            super(url); this.status=status; this.mime=mime; this.bytes=bytes;
        }
        @Override public int getResponseCode() { return status; }
        @Override public String getContentType() { return mime; }
        @Override public long getContentLengthLong() { return bytes.length; }
        @Override public java.io.InputStream getInputStream() { return new java.io.ByteArrayInputStream(bytes); }
        @Override public String getHeaderField(String name) { return null; }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return ""; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() throws SSLPeerUnverifiedException { return null; }
        @Override public Principal getPeerPrincipal() throws SSLPeerUnverifiedException { return null; }
        @Override public Principal getLocalPrincipal() { return null; }
    }

    private static Object getField(Object target, String name) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
