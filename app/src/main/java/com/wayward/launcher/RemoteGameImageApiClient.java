package com.wayward.launcher;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/** Maps the legacy Wayward HTML ImageGen API to the paired Host's authenticated game-image API. */
final class RemoteGameImageApiClient {
    private RemoteGameImageApiClient() {}

    static JSONObject execute(Context context, String method, String rawPath, byte[] requestBytes,
            JSONObject requestHeaders) throws Exception {
        if (context == null) throw new IllegalArgumentException("Launcher context is required.");
        String safeMethod = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        Uri uri = Uri.parse("https://wayward.invalid" + rawPath);
        String path = uri.getPath();
        if (path == null || !path.startsWith("/api/") || path.contains("\\") ||
                path.contains("/../") || path.endsWith("/..")) {
            throw new SecurityException("Remote ImageGen API path is invalid.");
        }

        RemoteHostConnection host = RemoteHostStore.loadConnection(context);
        String rootId = RemoteHostStore.getSelectedRootId(context);
        if (!RemoteHostStore.isPaired(context) || host == null ||
                rootId == null || !rootId.matches("(?i)[0-9a-f]{16}")) {
            throw new IllegalStateException("페어링된 PC와 승인된 PC 게임 폴더를 먼저 선택하세요.");
        }

        String rootQuery = "rootId=" + URLEncoder.encode(rootId, StandardCharsets.UTF_8.name());
        String target;
        String expectedMethod;
        if ("/api/generation/settings".equals(path)) {
            if (!"GET".equals(safeMethod) && !"PUT".equals(safeMethod))
                throw new SecurityException("Remote generation settings method is not allowed.");
            target = "/v1/game-image-api/generation/settings?" + rootQuery;
            expectedMethod = safeMethod;
        } else if ("/api/generation/resources".equals(path)) {
            target = "/v1/game-image-api/generation/resources?" + rootQuery;
            expectedMethod = "GET";
        } else if ("/api/generation/capabilities".equals(path)) {
            target = "/v1/game-image-api/generation/capabilities?" + rootQuery;
            expectedMethod = "GET";
        } else if ("/api/generation/characters/discover-batch".equals(path)) {
            target = "/v1/game-image-api/generation/characters/discover-batch?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/generation/characters/discover".equals(path)) {
            target = "/v1/game-image-api/generation/characters/discover?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/generation/prompt-batch-support".equals(path)) {
            target = "/v1/game-image-api/generation/prompt-batch-support?" + rootQuery;
            expectedMethod = "GET";
        } else if ("/api/generation/select-models-folder".equals(path)) {
            target = "/v1/game-image-api/generation/select-models-folder?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/image/health".equals(path)) {
            target = "/v1/game-image-api/health?" + rootQuery;
            expectedMethod = "GET";
        } else if ("/api/pack".equals(path)) {
            target = "/v1/game-image-api/pack?" + rootQuery;
            expectedMethod = "GET";
        } else if ("/api/image/generate".equals(path)) {
            target = "/v1/game-image-api/image/generate?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/image/cancel".equals(path)) {
            target = "/v1/game-image-api/image/cancel?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/image-hit".equals(path)) {
            target = "/v1/game-image-api/image-hit?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/batch/enqueue".equals(path)) {
            target = "/v1/game-image-api/batch/enqueue?" + rootQuery;
            expectedMethod = "POST";
        } else if ("/api/batch/status".equals(path)) {
            String jobId = uri.getQueryParameter("jobId");
            if (jobId != null && !jobId.isEmpty() && !jobId.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new SecurityException("Remote batch status jobId is invalid.");
            }
            target = "/v1/game-image-api/batch/status?" + rootQuery +
                    (jobId == null || jobId.isEmpty() ? "" : "&jobId=" +
                            URLEncoder.encode(jobId, StandardCharsets.UTF_8.name()));
            expectedMethod = "GET";
        } else if (path.matches("^/api/image/status/[0-9a-fA-F-]{36}$") &&
                path.substring("/api/image/status/".length()).matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            String promptId = path.substring("/api/image/status/".length());
            target = "/v1/game-image-api/image/status/" + promptId + "?" + rootQuery;
            expectedMethod = "GET";
        } else if (path.matches("^/api/batch/(pause|resume|clear)$")) {
            String action = path.substring("/api/batch/".length());
            String jobId = uri.getQueryParameter("jobId");
            if (jobId != null && !jobId.isEmpty() && !jobId.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new SecurityException("Remote batch control jobId is invalid.");
            }
            target = "/v1/game-image-api/batch/" + action + "?" + rootQuery +
                    (jobId == null || jobId.isEmpty() ? "" : "&jobId=" +
                            URLEncoder.encode(jobId, StandardCharsets.UTF_8.name()));
            expectedMethod = "POST";
        } else {
            throw new SecurityException("Remote ImageGen API route is not on the allowlist.");
        }

        if (!expectedMethod.equals(safeMethod)) {
            throw new SecurityException("Remote ImageGen API method does not match the allowlist.");
        }
        int maxBodyBytes = 4 * 1024 * 1024;
        if ("/api/generation/settings".equals(path) && "PUT".equals(safeMethod)
                || "/api/generation/characters/discover-batch".equals(path)
                || "/api/batch/enqueue".equals(path)) {
            maxBodyBytes = 2 * 1024 * 1024;
        } else if ("/api/generation/characters/discover".equals(path)
                || "/api/image/cancel".equals(path) || "/api/image-hit".equals(path)) {
            maxBodyBytes = 128 * 1024;
        }
        if (requestBytes != null && requestBytes.length > maxBodyBytes) {
            throw new IllegalArgumentException("Remote ImageGen JSON body exceeds the endpoint limit.");
        }
        if ("/api/generation/settings".equals(path) && "PUT".equals(safeMethod)
                && requestBytes != null && requestBytes.length > 0) {
            JSONObject body = new JSONObject(new String(requestBytes, StandardCharsets.UTF_8));
            // The paired PC owns ComfyUI, its endpoint and model paths. Only the
            // workflow family and generation preferences are accepted from Image Studio.
            removeCredentialFields(body);
            body.remove("comfyUrl");
            body.remove("modelsDirectory");
            body.remove("loraDirectory");
            body.remove("launcherProviderUrl");
            body.remove("launcherProfileId");
            body.remove("launcherProviderId");
            body.remove("launcherProviderSignature");
            body.remove("launcherProviderToken");
            body.put("imageProvider", "anima".equals(body.optString("imageProvider")) ? "anima" : "sdxl");
            byte[] sanitizedBytes=body.toString().getBytes(StandardCharsets.UTF_8);
            try{
                return RemoteHostClient.requestAuthenticatedRawJsonEnvelope(
                        context,host,target,safeMethod,sanitizedBytes,forwardedHeaders(requestHeaders));
            }finally{
                java.util.Arrays.fill(sanitizedBytes,(byte)0);
            }
        }
        return RemoteHostClient.requestAuthenticatedRawJsonEnvelope(
                context,host,target,safeMethod,requestBytes,forwardedHeaders(requestHeaders));
    }

    private static Map<String,String> forwardedHeaders(JSONObject source) {
        Map<String,String> result=new HashMap<>();
        if(source==null)return result;
        String[] allowed={"Range","If-Range","If-None-Match","If-Modified-Since",
                "Cache-Control","Accept","Upload-Offset"};
        for(String name:allowed){
            Iterator<String> keys=source.keys();
            while(keys.hasNext()){
                String key=keys.next();
                if(!name.equalsIgnoreCase(key))continue;
                Object value=source.opt(key);
                if(value==null||value==JSONObject.NULL)break;
                String text=String.valueOf(value);
                if(text.length()<=4096&&text.indexOf('\r')<0&&text.indexOf('\n')<0)
                    result.put(name,text);
                break;
            }
        }
        return result;
    }

    private static void removeCredentialFields(JSONObject object) {
        if(object==null)return;
        java.util.Iterator<String> keys=object.keys();
        java.util.ArrayList<String> remove=new java.util.ArrayList<>();
        while(keys.hasNext()){
            String key=keys.next();
            String normalized=key.toLowerCase(Locale.ROOT).replace("_","").replace("-","");
            if(normalized.equals("naitoken")||normalized.equals("naitokenclear")
                    ||normalized.equals("novelaitoken")||normalized.equals("token")
                    ||normalized.equals("apikey")||normalized.equals("authorization")
                    ||normalized.equals("accesstoken")||normalized.equals("refreshtoken")
                    ||normalized.equals("bearertoken")||normalized.equals("secret")){
                remove.add(key);
                continue;
            }
            Object value=object.opt(key);
            if(value instanceof JSONObject)removeCredentialFields((JSONObject)value);
            else if(value instanceof JSONArray){
                JSONArray array=(JSONArray)value;
                for(int i=0;i<array.length();i++){
                    Object item=array.opt(i);
                    if(item instanceof JSONObject)removeCredentialFields((JSONObject)item);
                    else if(item instanceof JSONArray)removeCredentialFieldsFromArray((JSONArray)item);
                }
            }
        }
        for(String key:remove)object.remove(key);
    }

    private static void removeCredentialFieldsFromArray(JSONArray array){
        if(array==null)return;
        for(int i=0;i<array.length();i++){
            Object item=array.opt(i);
            if(item instanceof JSONObject)removeCredentialFields((JSONObject)item);
            else if(item instanceof JSONArray)removeCredentialFieldsFromArray((JSONArray)item);
        }
    }

    static JSONObject unsupportedNaiResponse() {
        JSONObject result = new JSONObject();
        try {
            JSONObject body = new JSONObject()
                    .put("supported",false)
                    .put("configured",false)
                    .put("error","unsupported_provider")
                    .put("message","NovelAI credentials and generation are intentionally not forwarded or stored by PC Remote Host. Select SDXL or Anima.");
            result.put("status", 501);
            result.put("statusText", "Not Implemented");
            result.put("headers", new JSONObject().put("Content-Type", "application/json; charset=utf-8"));
            result.put("bodyBase64", Base64.encodeToString(
                    body.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        } catch (Exception ignored) {}
        return result;
    }

    static JSONObject failureResponse(Exception error) {
        String message=error==null||error.getMessage()==null
                ? "Remote PC 이미지 API 요청을 처리하지 못했습니다." : error.getMessage();
        if (RemoteHostClient.isDeviceRevokedError(error))
            return errorResponse(403,"Forbidden","PC에서 이 기기의 페어링을 해제했습니다.");
        if (error instanceof IllegalArgumentException && message.contains("exceeds the endpoint limit"))
            return errorResponse(413,"Payload Too Large","Remote ImageGen 요청 본문이 endpoint 제한을 초과했습니다.");
        if (error instanceof IllegalArgumentException || error instanceof org.json.JSONException)
            return errorResponse(400,"Bad Request","Remote ImageGen 요청 형식이 올바르지 않습니다.");
        if (error instanceof SecurityException)
            return errorResponse(403,"Forbidden","Remote ImageGen 요청이 허용되지 않았습니다.");
        if (error instanceof java.net.SocketTimeoutException)
            return errorResponse(504,"Gateway Timeout","PC Remote Host 응답 시간이 초과되었습니다.");
        if (error instanceof IllegalStateException)
            return errorResponse(503,"Service Unavailable",message);
        return errorResponse(502,"Bad Gateway","PC Remote Host에 연결하거나 요청을 완료하지 못했습니다.");
    }

    private static JSONObject errorResponse(int status,String statusText,String message) {
        JSONObject result=new JSONObject();
        try{
            JSONObject body=new JSONObject().put("error",message);
            result.put("status",status);
            result.put("statusText",statusText);
            result.put("headers",new JSONObject().put("Content-Type","application/json; charset=utf-8")
                    .put("Cache-Control","no-store"));
            result.put("bodyBase64",Base64.encodeToString(
                    body.toString().getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP));
        }catch(Exception ignored){}
        return result;
    }

    static JSONObject offlineResponse(String message) {
        JSONObject result = new JSONObject();
        try {
            JSONObject body = new JSONObject().put("error", message == null ? "Remote PC Host 연결 오류" : message);
            result.put("status", 503);
            result.put("statusText", "Remote Host Unavailable");
            result.put("headers", new JSONObject().put("Content-Type", "application/json; charset=utf-8"));
            result.put("bodyBase64", Base64.encodeToString(body.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        } catch (Exception ignored) {}
        return result;
    }
}
