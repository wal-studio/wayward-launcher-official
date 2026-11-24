package com.wayward.launcher;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

/**
 * Routes legacy/direct NovelAI image API calls through the launcher-owned
 * Android Keystore token. The game never supplies or controls the credential.
 */
final class NovelAiRequestProxy {
    private static final String LOCAL_PREFIX = "/api/nai-compat";
    private static final String NAI_ORIGIN = "https://image.novelai.net";
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int READ_TIMEOUT_MS = 15 * 60 * 1000;
    private static final int MAX_REQUEST_BYTES = 8 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

    private NovelAiRequestProxy() {}

    static void dispatch(WebView web, String requestId, String method,
                         String pathAndQuery, String headersJson, String bodyBase64, boolean providerEnabled) {
        if (web == null || requestId == null || !requestId.matches("[A-Za-z0-9._-]{1,80}")) return;
        String safeMethod = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        String endpoint = allowedEndpoint(pathAndQuery);
        if (!"POST".equals(safeMethod) || endpoint == null) {
            deliver(web, requestId, errorResponse(400, "허용되지 않은 NovelAI 이미지 요청입니다."));
            return;
        }

        Context context = web.getContext().getApplicationContext();
        if (!providerEnabled) {
            deliver(web, requestId, errorResponse(503, "런처에서 NovelAI 이미지 생성 모드를 선택하고 서버를 준비해야 합니다."));
            return;
        }

        new Thread(() -> {
            HttpsURLConnection connection = null;
            byte[] requestBody = null;
            long startedAt = System.currentTimeMillis();
            try {
                String token = NovelAiTokenStore.readToken(context);
                if (token == null || token.trim().isEmpty()) {
                    deliver(web, requestId, errorResponse(401, "런처에 NovelAI 토큰을 먼저 등록해 주세요."));
                    return;
                }

                requestBody = bodyBase64 == null || bodyBase64.isEmpty()
                        ? new byte[0] : Base64.decode(bodyBase64, Base64.DEFAULT);
                if (requestBody.length == 0 || requestBody.length > MAX_REQUEST_BYTES) {
                    deliver(web, requestId, errorResponse(413, "NovelAI 이미지 요청 본문이 비어 있거나 너무 큽니다."));
                    return;
                }

                connection = (HttpsURLConnection) new URL(NAI_ORIGIN + endpoint).openConnection();
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod("POST");
                connection.setUseCaches(false);
                connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + token.trim());
                JSONObject requestHeaders = headersJson == null || headersJson.isEmpty()
                        ? new JSONObject() : new JSONObject(headersJson);
                String contentType = requestHeaders.optString("content-type",
                        requestHeaders.optString("Content-Type", "application/json"));
                if (!contentType.toLowerCase(Locale.ROOT).startsWith("application/json")
                        || contentType.length() > 128 || contentType.indexOf('\r') >= 0
                        || contentType.indexOf('\n') >= 0) {
                    deliver(web, requestId, errorResponse(415, "NovelAI 이미지 요청은 JSON 형식이어야 합니다."));
                    return;
                }
                String accept = requestHeaders.optString("accept",
                        "application/zip, application/json");
                if (accept.length() > 512 || accept.indexOf('\r') >= 0 || accept.indexOf('\n') >= 0) {
                    deliver(web, requestId, errorResponse(400, "NovelAI 응답 형식 헤더가 올바르지 않습니다."));
                    return;
                }
                connection.setRequestProperty("Content-Type", contentType);
                connection.setRequestProperty("Accept", accept);
                connection.setRequestProperty("Accept-Encoding", "identity");

                try (OutputStream output = connection.getOutputStream()) {
                    output.write(requestBody);
                    output.flush();
                }

                int status = connection.getResponseCode();
                long contentLength = connection.getContentLengthLong();
                if (contentLength > MAX_RESPONSE_BYTES) {
                    deliver(web, requestId, errorResponse(413, "NovelAI 이미지 응답이 64MB 제한을 초과했습니다."));
                    return;
                }
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                byte[] responseBody = stream == null ? new byte[0] : readLimited(stream, MAX_RESPONSE_BYTES);
                if (stream != null) stream.close();
                if (status >= 200 && status < 300 && responseBody.length == 0) {
                    deliver(web, requestId, errorResponse(502, "NovelAI가 빈 이미지 응답을 반환했습니다."));
                    return;
                }

                JSONObject payload = new JSONObject();
                payload.put("status", status);
                payload.put("statusText", safeStatus(connection.getResponseMessage()));
                payload.put("headers", responseHeaders(connection.getHeaderFields()));
                payload.put("bodyBase64", Base64.encodeToString(responseBody, Base64.NO_WRAP));
                deliver(web, requestId, payload.toString());

                JSONObject diagnostic = new JSONObject();
                diagnostic.put("endpoint", endpoint);
                diagnostic.put("status", status);
                diagnostic.put("responseBytes", responseBody.length);
                diagnostic.put("elapsedMs", System.currentTimeMillis() - startedAt);
                DiagnosticsLogger.event(context, status >= 400 ? "WARN" : "INFO",
                        "novelai_request_proxy", "direct_image_request_completed", diagnostic);
                java.util.Arrays.fill(responseBody, (byte) 0);
            } catch (Exception error) {
                JSONObject diagnostic = new JSONObject();
                try {
                    diagnostic.put("endpoint", endpoint);
                    diagnostic.put("exception", error.getClass().getSimpleName());
                    diagnostic.put("elapsedMs", System.currentTimeMillis() - startedAt);
                } catch (Exception ignored) {}
                DiagnosticsLogger.event(context, "ERROR", "novelai_request_proxy",
                        "direct_image_request_failed", diagnostic);
                deliver(web, requestId, errorResponse(502, "NovelAI 이미지 서버 요청에 실패했습니다."));
            } finally {
                if (requestBody != null) java.util.Arrays.fill(requestBody, (byte) 0);
                if (connection != null) connection.disconnect();
            }
        }, "wayward-novelai-image-proxy").start();
    }

    private static String allowedEndpoint(String pathAndQuery) {
        if (pathAndQuery == null || pathAndQuery.length() > 4096
                || pathAndQuery.indexOf('\\') >= 0 || pathAndQuery.indexOf('\0') >= 0) return null;
        Uri uri = Uri.parse("http://127.0.0.1" + pathAndQuery);
        if (uri.getEncodedQuery() != null || uri.getFragment() != null) return null;
        String path = uri.getEncodedPath();
        if (path == null || !path.startsWith(LOCAL_PREFIX + "/")) return null;
        String endpoint = path.substring(LOCAL_PREFIX.length());
        if (endpoint.indexOf('%') >= 0) return null;
        if ("/ai/generate-image".equals(endpoint)
                || "/ai/generate-image-stream".equals(endpoint)
                || "/ai/augment-image".equals(endpoint)
                || "/ai/upscale".equals(endpoint)
                || "/oa/v1/images/generations".equals(endpoint)) return endpoint;
        return null;
    }

    private static byte[] readLimited(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[32768];
        int total = 0;
        while (true) {
            int count = input.read(buffer);
            if (count < 0) break;
            total += count;
            if (total > maxBytes) throw new IllegalStateException("NovelAI response exceeds size limit.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static JSONObject responseHeaders(Map<String, List<String>> source) throws Exception {
        JSONObject result = new JSONObject();
        for (Map.Entry<String, List<String>> entry : source.entrySet()) {
            String name = entry.getKey();
            if (name == null) continue;
            String lower = name.toLowerCase(Locale.ROOT);
            if (!(lower.equals("content-type") || lower.equals("cache-control")
                    || lower.equals("retry-after") || lower.equals("content-disposition")
                    || lower.equals("x-request-id"))) continue;
            List<String> values = entry.getValue();
            if (values != null && !values.isEmpty()) result.put(name, values.get(0));
        }
        return result;
    }

    private static String safeStatus(String value) {
        return value == null ? "" : value.replace('\r', ' ').replace('\n', ' ');
    }

    private static String errorResponse(int status, String message) {
        try {
            JSONObject body = new JSONObject();
            body.put("error", message);
            JSONObject headers = new JSONObject();
            headers.put("Content-Type", "application/json; charset=utf-8");
            JSONObject response = new JSONObject();
            response.put("status", status);
            response.put("statusText", "Proxy Error");
            response.put("headers", headers);
            response.put("bodyBase64", Base64.encodeToString(
                    body.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            return response.toString();
        } catch (Exception ignored) {
            return "{\"status\":502,\"statusText\":\"Proxy Error\",\"headers\":{},\"bodyBase64\":\"\"}";
        }
    }

    private static void deliver(WebView web, String requestId, String payload) {
        String js = "window.__waywardImageGenProxyResolve&&window.__waywardImageGenProxyResolve("
                + JSONObject.quote(requestId) + "," + JSONObject.quote(payload) + ");";
        web.post(() -> {
            try { web.evaluateJavascript(js, null); } catch (Exception ignored) {}
        });
    }
}
