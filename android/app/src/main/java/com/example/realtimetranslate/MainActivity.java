package com.example.realtimetranslate;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int PORT = 8765;
    private WebView webView;
    private LocalServer localServer;
    private SharedPreferences prefs;
    private AudioManager audioManager;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("realtime_translate", MODE_PRIVATE);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 10);
        }

        localServer = new LocalServer(this, prefs);
        localServer.start();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.loadUrl("http://127.0.0.1:" + PORT + "/index.html");
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("window.realtimeTranslateDisconnect && window.realtimeTranslateDisconnect()", null);
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (localServer != null) localServer.close();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void hasApiKey(String ignored, String callbackName) {
            boolean hasKey = !prefs.getString("openai_api_key", "").isEmpty();
            callback(callbackName, String.valueOf(hasKey));
        }

        @JavascriptInterface
        public void saveApiKey(String apiKey, String callbackName) {
            prefs.edit().putString("openai_api_key", apiKey.trim()).apply();
            callback(callbackName, "true");
        }

        @JavascriptInterface
        public void listAudioDevices(String kind, String callbackName) {
            JSONArray result = new JSONArray();
            int flag = "output".equals(kind)
                    ? AudioManager.GET_DEVICES_OUTPUTS
                    : AudioManager.GET_DEVICES_INPUTS;
            if (audioManager != null) {
                for (AudioDeviceInfo device : audioManager.getDevices(flag)) {
                    try {
                        result.put(new JSONObject()
                                .put("deviceId", String.valueOf(device.getId()))
                                .put("label", labelFor(device))
                                .put("kind", "output".equals(kind) ? "audiooutput" : "audioinput"));
                    } catch (Exception ignored) {
                    }
                }
            }
            callback(callbackName, result.toString());
        }

        @JavascriptInterface
        public void selectAudioDevice(String value, String callbackName) {
            boolean selected = selectCommunicationDevice(value);
            callback(callbackName, String.valueOf(selected));
        }

        private void callback(String callbackName, String value) {
            runOnUiThread(() -> webView.evaluateJavascript(
                    "window." + callbackName + "(" + JSONObject.quote(value) + ")", null));
        }

        private String labelFor(AudioDeviceInfo device) {
            CharSequence productName = device.getProductName();
            if (productName != null && productName.length() > 0) return productName.toString();
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                    return "内置麦克风";
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                    return "扬声器";
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                    return "有线耳机";
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                    return "蓝牙设备";
                case AudioDeviceInfo.TYPE_USB_DEVICE:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                    return "USB 音频设备";
                default:
                    return "音频设备 " + device.getId();
            }
        }

        private boolean selectCommunicationDevice(String value) {
            if (audioManager == null) return false;
            String[] parts = value.split(":", 2);
            if (parts.length != 2 || parts[1].isEmpty()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }
                return true;
            }

            int flag = "output".equals(parts[0])
                    ? AudioManager.GET_DEVICES_OUTPUTS
                    : AudioManager.GET_DEVICES_INPUTS;
            for (AudioDeviceInfo device : audioManager.getDevices(flag)) {
                if (!String.valueOf(device.getId()).equals(parts[1])) continue;
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    return audioManager.setCommunicationDevice(device);
                }
                return true;
            }
            return false;
        }
    }

    private static class LocalServer extends Thread {
        private final Context context;
        private final SharedPreferences prefs;
        private volatile boolean running = true;
        private ServerSocket serverSocket;

        LocalServer(Context context, SharedPreferences prefs) {
            this.context = context.getApplicationContext();
            this.prefs = prefs;
            setName("RealtimeTranslateLocalServer");
        }

        @Override
        public void run() {
            try {
                serverSocket = new ServerSocket(PORT);
                while (running) {
                    Socket socket = serverSocket.accept();
                    new Thread(() -> handle(socket)).start();
                }
            } catch (Exception ignored) {
            }
        }

        void close() {
            running = false;
            try {
                if (serverSocket != null) serverSocket.close();
            } catch (Exception ignored) {
            }
        }

        private void handle(Socket socket) {
            try (socket) {
                InputStream in = socket.getInputStream();
                ByteArrayOutputStream requestBytes = new ByteArrayOutputStream();
                int previous = -1;
                int current;
                while ((current = in.read()) != -1) {
                    requestBytes.write(current);
                    String tail = requestBytes.toString("ISO-8859-1").replace("\r", "");
                    if (previous == '\n' && current == '\n' || tail.endsWith("\n\n")) break;
                    previous = current;
                }

                String request = requestBytes.toString("UTF-8");
                String firstLine = request.split("\\r?\\n", 2)[0];
                String[] parts = firstLine.split(" ");
                if (parts.length < 2 || !"GET".equals(parts[0])) {
                    write(socket, 405, "application/json", "{\"error\":\"Method not allowed\"}");
                    return;
                }

                String path = parts[1];
                if (path.startsWith("/api/session")) {
                    writeSession(socket, path);
                    return;
                }

                serveAsset(socket, path);
            } catch (Exception ignored) {
            }
        }

        private void writeSession(Socket socket, String path) throws Exception {
            String apiKey = prefs.getString("openai_api_key", "");
            if (apiKey.isEmpty()) {
                write(socket, 401, "application/json", "{\"error\":\"Missing OpenAI API key\"}");
                return;
            }

            Map<String, String> query = parseQuery(path);
            String mode = query.getOrDefault("mode", "auto");
            String direction = direction(mode);
            JSONObject payload = new JSONObject()
                    .put("expires_after", new JSONObject()
                            .put("anchor", "created_at")
                            .put("seconds", 600))
                    .put("session", new JSONObject()
                            .put("type", "realtime")
                            .put("model", "gpt-realtime")
                            .put("instructions",
                                    "You are a live two-way interpreter. " + direction + " " +
                                    "Only output the translation. Do not explain, summarize, answer questions, or add commentary. " +
                                    "Preserve names, numbers, units, tone, and intent. Keep the result concise and spoken naturally.")
                            .put("output_modalities", new org.json.JSONArray().put("audio"))
                            .put("audio", new JSONObject()
                                    .put("input", new JSONObject()
                                            .put("transcription", new JSONObject()
                                                    .put("model", "gpt-4o-mini-transcribe"))
                                            .put("turn_detection", new JSONObject()
                                                    .put("type", "server_vad")
                                                    .put("threshold", 0.5)
                                                    .put("prefix_padding_ms", 300)
                                                    .put("silence_duration_ms", 450)
                                                    .put("create_response", true)
                                                    .put("interrupt_response", true)))
                                    .put("output", new JSONObject()
                                            .put("voice", "marin")
                                            .put("speed", 1))));

            HttpURLConnection conn = (HttpURLConnection) new URL("https://api.openai.com/v1/realtime/client_secrets").openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }

            int status = conn.getResponseCode();
            InputStream bodyStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readAll(bodyStream);
            write(socket, status, "application/json", body);
        }

        private static String direction(String mode) {
            switch (mode) {
                case "zh_en":
                    return "Translate Mandarin Chinese to natural English. If the user speaks English, briefly say that Chinese input is expected.";
                case "en_zh":
                    return "Translate English to natural Mandarin Chinese. If the user speaks Mandarin Chinese, briefly say that English input is expected.";
                default:
                    return "Detect whether the user spoke Mandarin Chinese or English. Translate Mandarin Chinese to natural English. Translate English to natural Mandarin Chinese.";
            }
        }

        private void serveAsset(Socket socket, String path) throws Exception {
            String cleanPath = path.split("\\?", 2)[0];
            if (cleanPath.equals("/") || cleanPath.isEmpty()) cleanPath = "/index.html";
            cleanPath = URLDecoder.decode(cleanPath, "UTF-8").replaceFirst("^/", "");
            if (cleanPath.contains("..")) {
                write(socket, 400, "application/json", "{\"error\":\"Bad path\"}");
                return;
            }

            try (InputStream asset = context.getAssets().open(cleanPath)) {
                byte[] body = readAllBytes(asset);
                write(socket, 200, mimeType(cleanPath), body);
            } catch (Exception error) {
                write(socket, 404, "application/json", "{\"error\":\"Not found\"}");
            }
        }

        private static Map<String, String> parseQuery(String path) {
            Map<String, String> result = new HashMap<>();
            String[] parts = path.split("\\?", 2);
            if (parts.length < 2) return result;
            for (String pair : parts[1].split("&")) {
                String[] kv = pair.split("=", 2);
                if (kv.length == 2) {
                    result.put(urlDecode(kv[0]), urlDecode(kv[1]));
                }
            }
            return result;
        }

        private static String urlDecode(String value) {
            try {
                return URLDecoder.decode(value, "UTF-8");
            } catch (Exception ignored) {
                return value;
            }
        }

        private static String mimeType(String path) {
            if (path.endsWith(".html")) return "text/html; charset=utf-8";
            if (path.endsWith(".css")) return "text/css; charset=utf-8";
            if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
            if (path.endsWith(".json")) return "application/json; charset=utf-8";
            return "application/octet-stream";
        }

        private static String readAll(InputStream in) throws Exception {
            return new String(readAllBytes(in), StandardCharsets.UTF_8);
        }

        private static byte[] readAllBytes(InputStream in) throws Exception {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        }

        private static void write(Socket socket, int status, String contentType, String body) throws Exception {
            write(socket, status, contentType, body.getBytes(StandardCharsets.UTF_8));
        }

        private static void write(Socket socket, int status, String contentType, byte[] body) throws Exception {
            OutputStream out = socket.getOutputStream();
            String reason = status >= 400 ? "Error" : "OK";
            String headers = "HTTP/1.1 " + status + " " + reason + "\r\n" +
                    "Content-Type: " + contentType + "\r\n" +
                    "Content-Length: " + body.length + "\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Connection: close\r\n\r\n";
            out.write(headers.getBytes(StandardCharsets.UTF_8));
            out.write(body);
            out.flush();
        }
    }
}
