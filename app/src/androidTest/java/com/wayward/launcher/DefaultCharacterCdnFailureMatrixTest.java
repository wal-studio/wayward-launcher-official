package com.wayward.launcher;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.security.Principal;
import java.security.cert.Certificate;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

@RunWith(AndroidJUnit4.class)
public final class DefaultCharacterCdnFailureMatrixTest {
    private static final Uri VALID = Uri.parse(
            "https://art.sintention.com/images/illustrious/situation/info/pippa/cdn-matrix.png");
    private static final byte[] PNG = android.util.Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
            android.util.Base64.DEFAULT);

    @Test
    public void commonCdnFailuresAreRejectedAndValidImageIsAccepted() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation()
                .startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        assertNotNull(activity);
        java.lang.reflect.Method fetch = MainActivity.class.getDeclaredMethod(
                "fetchDefaultCharacterCdnImage", Uri.class, AtomicInteger.class);
        fetch.setAccessible(true);
        try {
            int[] statuses = {400, 401, 403, 404, 408, 429, 500, 502, 503, 504, 201, 204};
            for (int status : statuses) {
                setFactory(url -> new FakeConnection(url, status, "image/png", PNG, null, null, PNG.length));
                assertNull("HTTP " + status + " must select local fallback",
                        fetch.invoke(activity, VALID, new AtomicInteger()));
            }
            assertThrowsFallback(activity, fetch, new UnknownHostException("dns"));
            assertThrowsFallback(activity, fetch, new ConnectException("refused"));
            assertThrowsFallback(activity, fetch, new SSLHandshakeException("tls"));
            assertThrowsFallback(activity, fetch, new SocketTimeoutException("connect timeout"));
            assertThrowsFallback(activity, fetch, new SocketTimeoutException("response read timeout"));
            assertThrowsFallback(activity, fetch, new IOException("connection aborted"));

            setFactory(url -> new FakeConnection(url, 302, "image/png", PNG, null, null, PNG.length));
            assertNull("redirect without Location must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 302, "image/png", PNG,
                    "https://evil.example/images/illustrious/situation/info/pippa/x.png", null, PNG.length));
            assertNull("redirect to an unapproved host must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));

            AtomicInteger redirects = new AtomicInteger();
            setFactory(url -> new FakeConnection(url, 302, "image/png", PNG,
                    "https://art.sintention.com/images/illustrious/situation/info/pippa/r"
                            + redirects.incrementAndGet() + ".png", null, PNG.length));
            assertNull("redirect limit must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            assertEquals("initial request plus three redirects", 4, redirects.get());

            setFactory(url -> new FakeConnection(url, 200, "text/html", PNG, null, null, PNG.length));
            assertNull("non-image MIME must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/png", new byte[0], null, null, 0));
            assertNull("empty body must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/png", "not an image".getBytes(), null, null, 12));
            assertNull("invalid image signature must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/jpeg", PNG, null, null, PNG.length));
            assertNull("MIME/signature mismatch must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/png", PNG, null, null, PNG.length + 1));
            assertNull("declared Content-Length mismatch must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/png", PNG, null, null, 12L * 1024L * 1024L + 1));
            assertNull("declared size over 12 MiB must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            byte[] tooLarge = new byte[12 * 1024 * 1024 + 1];
            tooLarge[0]=(byte)0x89;tooLarge[1]='P';tooLarge[2]='N';tooLarge[3]='G';
            tooLarge[4]=13;tooLarge[5]=10;tooLarge[6]=26;tooLarge[7]=10;
            setFactory(url -> new FakeConnection(url, 200, "image/png", tooLarge, null, null, -1));
            assertNull("streamed size over 12 MiB must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));
            setFactory(url -> new FakeConnection(url, 200, "image/png", PNG, null,
                    new IOException("stream interrupted"), PNG.length));
            assertNull("stream read error must fall back", fetch.invoke(activity, VALID, new AtomicInteger()));

            setFactory(url -> new FakeConnection(url, 200, "image/png", PNG, null, null, PNG.length));
            WebResourceResponse accepted = (WebResourceResponse) fetch.invoke(activity, VALID, new AtomicInteger());
            assertNotNull("valid CDN image should be returned without local lookup", accepted);
            assertEquals(200, accepted.getStatusCode());
            assertEquals("image/png", accepted.getMimeType());
            accepted.getData().close();
        } finally {
            setFactory(null);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    private static void assertThrowsFallback(MainActivity activity, java.lang.reflect.Method fetch,
                                              IOException failure) throws Exception {
        setFactory(url -> { throw failure; });
        assertNull(failure.getClass().getSimpleName() + " must select local fallback",
                fetch.invoke(activity, VALID, new AtomicInteger()));
    }

    private static void setFactory(MainActivity.DefaultCharacterCdnConnectionFactory factory) {
        MainActivity.setDefaultCharacterCdnConnectionFactoryForTesting(factory);
    }

    private interface Factory extends MainActivity.DefaultCharacterCdnConnectionFactory {}

    private static final class FakeConnection extends HttpsURLConnection {
        private final int status;
        private final String mime;
        private final byte[] bytes;
        private final String location;
        private final IOException streamFailure;
        private final long contentLength;
        FakeConnection(URL url, int status, String mime, byte[] bytes, String location,
                       IOException streamFailure, long contentLength) {
            super(url);this.status=status;this.mime=mime;this.bytes=bytes;
            this.location=location;this.streamFailure=streamFailure;this.contentLength=contentLength;
        }
        @Override public int getResponseCode() { return status; }
        @Override public String getContentType() { return mime; }
        @Override public long getContentLengthLong() { return contentLength; }
        @Override public String getHeaderField(String name) {
            return "Location".equalsIgnoreCase(name)?location:null;
        }
        @Override public ByteArrayInputStream getInputStream() throws IOException {
            if(streamFailure!=null)throw streamFailure;
            return new ByteArrayInputStream(bytes);
        }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return ""; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() throws SSLPeerUnverifiedException { return null; }
        @Override public Principal getPeerPrincipal() throws SSLPeerUnverifiedException { return null; }
        @Override public Principal getLocalPrincipal() { return null; }
    }
}
