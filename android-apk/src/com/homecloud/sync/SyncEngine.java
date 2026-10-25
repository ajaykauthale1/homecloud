package com.homecloud.sync;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

public class SyncEngine {
    private static final String PREFS_NAME = "HomeCloudPrefs";
    private static final String DEFAULT_PC_IP = "192.168.1.159";
    private static final int DEFAULT_PORT = 4820;
    private static final String CHANNEL_ID = "homecloud_sync_channel";

    private static final AtomicBoolean isRunning = new AtomicBoolean(false);
    private static StatusListener activeListener = null;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    public interface StatusListener {
        void onStatusChanged(String phase, String message, int current, int total, String serverName, String serverIp, boolean online);
    }

    public static void setStatusListener(StatusListener listener) {
        activeListener = listener;
    }

    private static void notifyUI(final String phase, final String message, final int current, final int total, final String serverName, final String serverIp, final boolean online) {
        if (activeListener != null) {
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (activeListener != null) {
                        activeListener.onStatusChanged(phase, message, current, total, serverName, serverIp, online);
                    }
                }
            });
        }
    }

    public static SharedPreferences getPrefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static String getDeviceId(Context ctx) {
        SharedPreferences prefs = getPrefs(ctx);
        String id = prefs.getString("device_id", null);
        if (id == null) {
            id = "android-" + UUID.randomUUID().toString().substring(0, 8);
            prefs.edit().putString("device_id", id).apply();
        }
        return id;
    }

    public static String getDeviceName() {
        String manufacturer = Build.MANUFACTURER != null ? Build.MANUFACTURER : "";
        String model = Build.MODEL != null ? Build.MODEL : "Android Phone";
        if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
            return model;
        }
        return (manufacturer + " " + model).trim();
    }

    public static boolean isOnWifi(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            // Check all networks so an active VPN (TRANSPORT_VPN) does not hide Wi-Fi
            Network[] networks = cm.getAllNetworks();
            if (networks != null) {
                for (Network net : networks) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                    if (caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                        return true;
                    }
                }
            }
            // Fallback: if phone has a private LAN IPv4 address, treat as on LAN
            return getPhoneWifiIp() != null;
        } catch (Exception e) {
            return true;
        }
    }

    public static JSONObject pingServer(String ip, int port, int timeoutMs) {
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL("http://" + ip + ":" + port + "/api/discover");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs);
                if (conn.getResponseCode() == 200) {
                    String body = readStream(conn.getInputStream());
                    JSONObject json = new JSONObject(body);
                    if ("homecloud".equals(json.optString("service"))) {
                        json.put("ip", ip);
                        json.put("port", port);
                        return json;
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return null;
    }

    private static String getPhoneWifiIp() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (!intf.isUp() || intf.isLoopback()) continue;
                List<InetAddress> addrs = Collections.list(intf.getInetAddresses());
                for (InetAddress addr : addrs) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        String sAddr = addr.getHostAddress();
                        if (sAddr.startsWith("192.168.") || sAddr.startsWith("10.") || sAddr.startsWith("172.")) {
                            return sAddr;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * Zero-Touch Auto-Discovery:
     * 1. Checks saved IP first
     * 2. Checks default PC IP (192.168.1.159)
     * 3. Scans the local /24 Wi-Fi subnet in parallel if DHCP changed the PC's IP
     */
    public static JSONObject discoverServerOnWifi(Context ctx) {
        SharedPreferences prefs = getPrefs(ctx);
        String savedIp = prefs.getString("server_ip", DEFAULT_PC_IP).trim();
        int port = prefs.getInt("server_port", DEFAULT_PORT);

        // Strip http:// or :port if user typed it into the IP box
        savedIp = savedIp.replace("http://", "").replace("https://", "");
        if (savedIp.contains(":")) {
            String[] hp = savedIp.split(":");
            savedIp = hp[0].trim();
        }
        if (savedIp.isEmpty()) savedIp = DEFAULT_PC_IP;

        // 1. Try saved IP with generous 2200ms timeout for initial Wi-Fi ARP
        JSONObject hit = pingServer(savedIp, port, 2200);
        if (hit != null) return hit;

        // 2. Try default PC IP if different
        if (!DEFAULT_PC_IP.equals(savedIp)) {
            hit = pingServer(DEFAULT_PC_IP, port, 2200);
            if (hit != null) {
                prefs.edit().putString("server_ip", DEFAULT_PC_IP).apply();
                return hit;
            }
        }

        // 3. Fast parallel subnet scan
        String phoneIp = getPhoneWifiIp();
        if (phoneIp != null && phoneIp.contains(".")) {
            String[] parts = phoneIp.split("\\.");
            if (parts.length == 4) {
                final String prefix = parts[0] + "." + parts[1] + "." + parts[2] + ".";
                final int selfHost = Integer.parseInt(parts[3]);
                final int targetPort = port;

                ExecutorService pool = Executors.newFixedThreadPool(32);
                List<Callable<JSONObject>> tasks = new ArrayList<>();
                for (int i = 1; i <= 254; i++) {
                    if (i == selfHost) continue;
                    final String candidateIp = prefix + i;
                    tasks.add(new Callable<JSONObject>() {
                        @Override
                        public JSONObject call() {
                            try {
                                Socket s = new Socket();
                                s.connect(new InetSocketAddress(candidateIp, targetPort), 650);
                                s.close();
                                return pingServer(candidateIp, targetPort, 1200);
                            } catch (Exception e) {
                                return null;
                            }
                        }
                    });
                }
                try {
                    List<Future<JSONObject>> results = pool.invokeAll(tasks);
                    pool.shutdownNow();
                    for (Future<JSONObject> f : results) {
                        JSONObject found = f.get();
                        if (found != null) {
                            prefs.edit()
                                .putString("server_ip", found.optString("ip"))
                                .putString("server_name", found.optString("serverName", "HomeCloud-PC"))
                                .apply();
                            return found;
                        }
                    }
                } catch (Exception ignored) {
                    pool.shutdownNow();
                }
            }
        }
        return null;
    }

    public static void startAsyncSync(final Context ctx, final boolean manualTrigger, final Runnable onComplete) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    runSyncBlocking(ctx, manualTrigger);
                } finally {
                    if (onComplete != null) onComplete.run();
                }
            }
        }).start();
    }

    private static class MediaItem {
        long id;
        Uri uri;
        String filename;
        long size;
        long dateTaken;
        String mediaType;
    }

    public static void runSyncBlocking(Context ctx, boolean manualTrigger) {
        if (!isRunning.compareAndSet(false, true)) {
            return;
        }

        SharedPreferences prefs = getPrefs(ctx);
        String savedName = prefs.getString("server_name", "HomeCloud-PC");
        String savedIp = prefs.getString("server_ip", DEFAULT_PC_IP);

        try {
            boolean autoSync = prefs.getBoolean("auto_sync_wifi", true);
            if (!manualTrigger && !autoSync) {
                return;
            }

            if (!manualTrigger && !isOnWifi(ctx)) {
                notifyUI("idle", "Waiting for Home Wi-Fi connection...", 0, 0, savedName, savedIp, false);
                return;
            }

            notifyUI("discovering", "Connecting to HomeCloud Desktop (" + savedIp + ":4820)...", 0, 0, savedName, savedIp, false);
            JSONObject server = discoverServerOnWifi(ctx);
            if (server == null) {
                String myIp = getPhoneWifiIp();
                String ipHint = (myIp != null) ? ("Phone IP: " + myIp) : "No Wi-Fi IP";
                notifyUI("offline", "Cannot reach PC at " + savedIp + ":4820 (" + ipHint + " — connect to 'Fandry 2' Wi-Fi & disable VPN)", 0, 0, savedName, savedIp, false);
                return;
            }

            String ip = server.optString("ip", savedIp);
            int port = server.optInt("port", DEFAULT_PORT);
            String serverName = server.optString("serverName", "HomeCloud-PC");
            prefs.edit()
                .putString("server_ip", ip)
                .putString("server_name", serverName)
                .apply();

            String baseUrl = "http://" + ip + ":" + port;
            String deviceId = getDeviceId(ctx);
            String deviceName = getDeviceName();

            // Auto-register / pair silently with Desktop
            try {
                JSONObject pairBody = new JSONObject();
                pairBody.put("deviceId", deviceId);
                pairBody.put("deviceName", deviceName);
                pairBody.put("platform", "Android Native");
                postJson(baseUrl + "/api/pair", pairBody.toString());
            } catch (Exception ignored) {}

            notifyUI("scanning", "Connected to " + serverName + ". Scanning photos...", 0, 0, serverName, ip, true);

            boolean includeVideos = prefs.getBoolean("include_videos", true);
            List<MediaItem> mediaList = queryDeviceMedia(ctx, includeVideos, 350);

            if (mediaList.isEmpty()) {
                notifyUI("completed", "Connected to " + serverName + " • No photos in camera roll.", 0, 0, serverName, ip, true);
                return;
            }

            Set<String> localSynced = new HashSet<>(prefs.getStringSet("synced_ids", new HashSet<String>()));
            List<MediaItem> candidates = new ArrayList<>();
            for (MediaItem m : mediaList) {
                if (!localSynced.contains(String.valueOf(m.id))) {
                    candidates.add(m);
                }
            }

            if (candidates.isEmpty()) {
                notifyUI("completed", "All " + mediaList.size() + " recent photos are backed up to " + serverName + "!", 0, 0, serverName, ip, true);
                return;
            }

            // Ask Desktop which candidate items are unsynced
            JSONArray assetsJson = new JSONArray();
            for (MediaItem m : candidates) {
                JSONObject o = new JSONObject();
                o.put("id", String.valueOf(m.id));
                o.put("filename", m.filename);
                o.put("size", m.size);
                o.put("creationTime", m.dateTaken);
                assetsJson.put(o);
            }

            JSONObject checkReq = new JSONObject();
            checkReq.put("deviceId", deviceId);
            checkReq.put("assets", assetsJson);

            String checkRespStr = postJson(baseUrl + "/api/check-sync", checkReq.toString());
            JSONObject checkResp = new JSONObject(checkRespStr);
            JSONArray unsyncedArr = checkResp.optJSONArray("unsyncedIds");
            Set<String> unsyncedSet = new HashSet<>();
            if (unsyncedArr != null) {
                for (int i = 0; i < unsyncedArr.length(); i++) {
                    unsyncedSet.add(unsyncedArr.getString(i));
                }
            }

            List<MediaItem> toUpload = new ArrayList<>();
            for (MediaItem m : candidates) {
                String key = String.valueOf(m.id);
                if (unsyncedSet.contains(key)) {
                    toUpload.add(m);
                } else {
                    localSynced.add(key);
                }
            }
            prefs.edit().putStringSet("synced_ids", localSynced).apply();

            if (toUpload.isEmpty()) {
                notifyUI("completed", "Up to date! All " + mediaList.size() + " items are safely in your PC vault.", 0, 0, serverName, ip, true);
                return;
            }

            // Reverse so oldest uploads first
            Collections.reverse(toUpload);
            int uploadedCount = 0;
            int total = toUpload.size();

            showSyncNotification(ctx, "HomeCloud Wi-Fi Auto-Sync", "Backing up " + total + " new photos to " + serverName + "...");

            for (int i = 0; i < total; i++) {
                MediaItem item = toUpload.get(i);
                int currentNum = i + 1;
                notifyUI("uploading", "Syncing " + currentNum + " / " + total + ": " + item.filename, currentNum, total, serverName, ip, true);

                // Report progress to Desktop GUI banner
                try {
                    JSONObject prog = new JSONObject();
                    prog.put("deviceId", deviceId);
                    prog.put("deviceName", deviceName);
                    prog.put("status", "syncing");
                    prog.put("current", currentNum);
                    prog.put("total", total);
                    prog.put("lastFile", item.filename);
                    postJson(baseUrl + "/api/sync-progress", prog.toString());
                } catch (Exception ignored) {}

                boolean ok = uploadMultipartMedia(ctx, baseUrl + "/api/upload", item, deviceId, deviceName);
                if (ok) {
                    uploadedCount++;
                    localSynced.add(String.valueOf(item.id));
                    prefs.edit().putStringSet("synced_ids", localSynced).apply();
                }
            }

            // Clear Desktop live progress banner
            try {
                JSONObject done = new JSONObject();
                done.put("deviceId", deviceId);
                done.put("deviceName", deviceName);
                done.put("status", "completed");
                postJson(baseUrl + "/api/sync-progress", done.toString());
            } catch (Exception ignored) {}

            int totalBackedUp = prefs.getInt("total_backed_up", 0) + uploadedCount;
            prefs.edit().putInt("total_backed_up", totalBackedUp).apply();

            showSyncNotification(ctx, "HomeCloud Sync Complete", "Backed up " + uploadedCount + " new items to " + serverName);
            notifyUI("completed", "✅ Synced " + uploadedCount + " new items to " + serverName + "!", total, total, serverName, ip, true);

        } catch (Exception e) {
            notifyUI("error", "Sync paused: " + e.getMessage(), 0, 0, savedName, savedIp, false);
        } finally {
            isRunning.set(false);
        }
    }

    private static List<MediaItem> queryDeviceMedia(Context ctx, boolean includeVideos, int limit) {
        List<MediaItem> list = new ArrayList<>();
        queryUri(ctx, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "photo", limit, list);
        if (includeVideos) {
            queryUri(ctx, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video", limit / 2, list);
        }
        return list;
    }

    private static void queryUri(Context ctx, Uri contentUri, String mediaType, int limit, List<MediaItem> out) {
        ContentResolver cr = ctx.getContentResolver();
        String[] proj = new String[]{
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED
        };
        Cursor c = null;
        try {
            c = cr.query(contentUri, proj, null, null, MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
            if (c != null) {
                int count = 0;
                int idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                int nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
                int sizeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                int modCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED);

                while (c.moveToNext() && count < limit) {
                    long id = c.getLong(idCol);
                    String name = c.getString(nameCol);
                    long size = c.getLong(sizeCol);
                    long mod = c.getLong(modCol) * 1000L;
                    if (size <= 0) continue;

                    MediaItem item = new MediaItem();
                    item.id = id;
                    item.uri = ContentUris.withAppendedId(contentUri, id);
                    item.filename = (name != null && !name.isEmpty()) ? name : ("IMG_" + id + ".jpg");
                    item.size = size;
                    item.dateTaken = mod > 0 ? mod : System.currentTimeMillis();
                    item.mediaType = mediaType;
                    out.add(item);
                    count++;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
    }

    private static boolean uploadMultipartMedia(Context ctx, String uploadUrl, MediaItem item, String deviceId, String deviceName) {
        String boundary = "----HomeCloudBoundary" + System.currentTimeMillis();
        HttpURLConnection conn = null;
        InputStream fileStream = null;
        try {
            fileStream = ctx.getContentResolver().openInputStream(item.uri);
            if (fileStream == null) return false;

            URL url = new URL(uploadUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setDoOutput(true);
            conn.setDoInput(true);
            conn.setUseCaches(false);
            conn.setChunkedStreamingMode(64 * 1024);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(60000);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

            DataOutputStream out = new DataOutputStream(conn.getOutputStream());
            writeFormField(out, boundary, "assetId", String.valueOf(item.id));
            writeFormField(out, boundary, "deviceId", deviceId);
            writeFormField(out, boundary, "deviceName", deviceName);
            writeFormField(out, boundary, "originalName", item.filename);
            writeFormField(out, boundary, "capturedAt", String.valueOf(item.dateTaken));
            writeFormField(out, boundary, "mediaType", item.mediaType);

            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"file\"; filename=\"" + item.filename + "\"\r\n");
            out.writeBytes("Content-Type: application/octet-stream\r\n\r\n");

            byte[] buffer = new byte[32 * 1024];
            int bytesRead;
            while ((bytesRead = fileStream.read(buffer)) != -1) {
                out.write(buffer, 0, bytesRead);
            }
            out.writeBytes("\r\n");
            out.writeBytes("--" + boundary + "--\r\n");
            out.flush();
            out.close();

            int status = conn.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception e) {
            return false;
        } finally {
            try { if (fileStream != null) fileStream.close(); } catch (Exception ignored) {}
            if (conn != null) conn.disconnect();
        }
    }

    private static void writeFormField(DataOutputStream out, String boundary, String name, String value) throws Exception {
        out.writeBytes("--" + boundary + "\r\n");
        out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        out.write(value.getBytes("UTF-8"));
        out.writeBytes("\r\n");
    }

    private static String postJson(String urlStr, String jsonBody) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(10000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            byte[] bytes = jsonBody.getBytes("UTF-8");
            OutputStream os = conn.getOutputStream();
            os.write(bytes);
            os.close();
            return readStream(conn.getInputStream());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readStream(InputStream is) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) {
            sb.append(line);
        }
        br.close();
        return sb.toString();
    }

    private static void showSyncNotification(Context ctx, String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "HomeCloud Wi-Fi Sync", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(ch);
                Notification n = new Notification.Builder(ctx, CHANNEL_ID)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                    .setAutoCancel(true)
                    .build();
                nm.notify(4820, n);
            }
        } catch (Exception ignored) {}
    }
}
