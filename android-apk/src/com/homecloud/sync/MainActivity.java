package com.homecloud.sync;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity implements SyncEngine.StatusListener {
    private TextView tvServerTitle;
    private TextView tvServerSub;
    private TextView tvSyncStatus;
    private ProgressBar progressBar;
    private Button btnSyncNow;
    private EditText etServerIp;
    private ConnectivityManager.NetworkCallback wifiCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.parseColor("#090D16"));
            getWindow().setNavigationBarColor(Color.parseColor("#090D16"));
        }

        buildUI();
        SyncEngine.setStatusListener(this);
        WifiSyncJobService.scheduleAllBackgroundJobs(this);
        registerWifiListener();
        checkPermissionsAndStartSync();
    }

    private int dp(int v) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(v * density);
    }

    private GradientDrawable roundedBox(String hexFill, String hexStroke, int radiusDp) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(hexFill));
        gd.setCornerRadius(dp(radiusDp));
        if (hexStroke != null) {
            gd.setStroke(dp(1), Color.parseColor(hexStroke));
        }
        return gd;
    }

    private void buildUI() {
        final SharedPreferences prefs = SyncEngine.getPrefs(this);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#090D16"));
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(22), dp(18), dp(36));
        scroll.addView(root);

        // Header
        TextView title = new TextView(this);
        title.setText("☁️ HomeCloud Wi-Fi Sync");
        title.setTextColor(Color.parseColor("#F8FAFC"));
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Automatic Background Photo & Video Backup on Same Wi-Fi");
        subtitle.setTextColor(Color.parseColor("#94A3B8"));
        subtitle.setTextSize(13);
        subtitle.setPadding(0, dp(4), 0, dp(18));
        root.addView(subtitle);

        // Card 1: Connection & Live Sync Status
        LinearLayout statusCard = new LinearLayout(this);
        statusCard.setOrientation(LinearLayout.VERTICAL);
        statusCard.setBackground(roundedBox("#111827", "#1F2937", 16));
        statusCard.setPadding(dp(18), dp(18), dp(18), dp(18));
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        cardLp.bottomMargin = dp(16);
        statusCard.setLayoutParams(cardLp);

        tvServerTitle = new TextView(this);
        String savedServer = prefs.getString("server_name", "LAPTOP-PAESL2A7");
        tvServerTitle.setText("🟢 " + savedServer);
        tvServerTitle.setTextColor(Color.parseColor("#F8FAFC"));
        tvServerTitle.setTextSize(17);
        tvServerTitle.setTypeface(Typeface.DEFAULT_BOLD);
        statusCard.addView(tvServerTitle);

        tvServerSub = new TextView(this);
        String savedIp = prefs.getString("server_ip", "192.168.1.159");
        tvServerSub.setText("Auto-Connecting on Wi-Fi (" + savedIp + ":4820)");
        tvServerSub.setTextColor(Color.parseColor("#38BDF8"));
        tvServerSub.setTextSize(13);
        tvServerSub.setPadding(0, dp(4), 0, dp(14));
        statusCard.addView(tvServerSub);

        LinearLayout progressBox = new LinearLayout(this);
        progressBox.setOrientation(LinearLayout.VERTICAL);
        progressBox.setBackground(roundedBox("#161F33", null, 12));
        progressBox.setPadding(dp(14), dp(12), dp(14), dp(12));

        tvSyncStatus = new TextView(this);
        tvSyncStatus.setText("Ready — Automatically syncs when connected to Home Wi-Fi");
        tvSyncStatus.setTextColor(Color.parseColor("#E2E8F0"));
        tvSyncStatus.setTextSize(13.5f);
        progressBox.addView(tvSyncStatus);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setPadding(0, dp(10), 0, 0);
        progressBar.setVisibility(View.GONE);
        progressBox.addView(progressBar);

        statusCard.addView(progressBox);

        btnSyncNow = new Button(this);
        btnSyncNow.setText("🔄 Sync Photos Now");
        btnSyncNow.setTextColor(Color.WHITE);
        btnSyncNow.setTextSize(15);
        btnSyncNow.setAllCaps(false);
        btnSyncNow.setTypeface(Typeface.DEFAULT_BOLD);
        btnSyncNow.setBackground(roundedBox("#0284C7", null, 12));
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48)
        );
        btnLp.topMargin = dp(14);
        btnSyncNow.setLayoutParams(btnLp);
        btnSyncNow.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String customIp = etServerIp.getText().toString().trim();
                if (!customIp.isEmpty()) {
                    prefs.edit().putString("server_ip", customIp).apply();
                }
                checkPermissionsAndStartSync();
            }
        });
        statusCard.addView(btnSyncNow);
        root.addView(statusCard);

        // Card 2: Background Wi-Fi Rules
        LinearLayout rulesCard = new LinearLayout(this);
        rulesCard.setOrientation(LinearLayout.VERTICAL);
        rulesCard.setBackground(roundedBox("#111827", "#1F2937", 16));
        rulesCard.setPadding(dp(18), dp(18), dp(18), dp(18));
        rulesCard.setLayoutParams(cardLp);

        TextView rulesHeader = new TextView(this);
        rulesHeader.setText("Background Auto-Sync Settings");
        rulesHeader.setTextColor(Color.parseColor("#F8FAFC"));
        rulesHeader.setTextSize(16);
        rulesHeader.setTypeface(Typeface.DEFAULT_BOLD);
        rulesHeader.setPadding(0, 0, 0, dp(12));
        rulesCard.addView(rulesHeader);

        Switch swAutoWifi = new Switch(this);
        swAutoWifi.setText("Auto-Sync in Background on Same Wi-Fi");
        swAutoWifi.setTextColor(Color.parseColor("#E2E8F0"));
        swAutoWifi.setTextSize(14);
        swAutoWifi.setChecked(prefs.getBoolean("auto_sync_wifi", true));
        swAutoWifi.setPadding(0, dp(8), 0, dp(12));
        swAutoWifi.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                prefs.edit().putBoolean("auto_sync_wifi", isChecked).apply();
                if (isChecked) {
                    SyncEngine.startAsyncSync(MainActivity.this, false, null);
                }
            }
        });
        rulesCard.addView(swAutoWifi);

        Switch swVideos = new Switch(this);
        swVideos.setText("Include Videos in Backup (YYYY/MM)");
        swVideos.setTextColor(Color.parseColor("#E2E8F0"));
        swVideos.setTextSize(14);
        swVideos.setChecked(prefs.getBoolean("include_videos", true));
        swVideos.setPadding(0, dp(8), 0, dp(12));
        swVideos.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                prefs.edit().putBoolean("include_videos", isChecked).apply();
            }
        });
        rulesCard.addView(swVideos);

        Switch swKeepBackup = new Switch(this);
        swKeepBackup.setText("Keep PC Backup Safe If Deleted on Phone");
        swKeepBackup.setTextColor(Color.parseColor("#4ADE80"));
        swKeepBackup.setTextSize(14);
        swKeepBackup.setChecked(prefs.getBoolean("keep_backup_on_delete", true));
        swKeepBackup.setPadding(0, dp(8), 0, dp(12));
        swKeepBackup.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                prefs.edit().putBoolean("keep_backup_on_delete", isChecked).apply();
            }
        });
        rulesCard.addView(swKeepBackup);

        TextView ipLabel = new TextView(this);
        ipLabel.setText("Desktop LAN IP (Auto-Discovered on Wi-Fi):");
        ipLabel.setTextColor(Color.parseColor("#94A3B8"));
        ipLabel.setTextSize(12.5f);
        ipLabel.setPadding(0, dp(8), 0, dp(6));
        rulesCard.addView(ipLabel);

        etServerIp = new EditText(this);
        etServerIp.setText(prefs.getString("server_ip", "192.168.1.159"));
        etServerIp.setTextColor(Color.parseColor("#F8FAFC"));
        etServerIp.setHintTextColor(Color.parseColor("#64748B"));
        etServerIp.setHint("192.168.1.159");
        etServerIp.setSingleLine(true);
        etServerIp.setBackground(roundedBox("#090D16", "#334155", 10));
        etServerIp.setPadding(dp(12), dp(10), dp(12), dp(10));
        rulesCard.addView(etServerIp);

        root.addView(rulesCard);

        setContentView(scroll);
    }

    private void checkPermissionsAndStartSync() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> needed = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.READ_MEDIA_IMAGES);
                }
                if (checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.READ_MEDIA_VIDEO);
                }
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.POST_NOTIFICATIONS);
                }
            } else {
                if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.READ_EXTERNAL_STORAGE);
                }
            }
            if (!needed.isEmpty()) {
                requestPermissions(needed.toArray(new String[0]), 200);
                return;
            }
        }
        SyncEngine.startAsyncSync(this, true, null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        WifiSyncJobService.scheduleAllBackgroundJobs(this);
        SyncEngine.startAsyncSync(this, true, null);
    }

    private void registerWifiListener() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build();
            wifiCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    SyncEngine.startAsyncSync(getApplicationContext(), false, null);
                }
            };
            cm.registerNetworkCallback(req, wifiCallback);
        } catch (Exception ignored) {}
    }

    @Override
    protected void onResume() {
        super.onResume();
        SyncEngine.setStatusListener(this);
        SyncEngine.startAsyncSync(this, false, null);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        SyncEngine.setStatusListener(null);
        try {
            if (wifiCallback != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(wifiCallback);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onStatusChanged(String phase, String message, int current, int total, String serverName, String serverIp, boolean online) {
        tvServerTitle.setText((online ? "🟢 " : "🟡 ") + serverName);
        tvServerSub.setText(online
            ? ("Connected on Same Wi-Fi (" + serverIp + ":4820)")
            : ("Waiting for Home Wi-Fi / Desktop (" + serverIp + ":4820)"));
        tvSyncStatus.setText(message);
        if (serverIp != null && !serverIp.isEmpty() && !etServerIp.hasFocus()) {
            etServerIp.setText(serverIp);
        }
        if ("uploading".equals(phase) && total > 0) {
            progressBar.setVisibility(View.VISIBLE);
            int pct = Math.min(100, Math.round((current * 100f) / total));
            progressBar.setProgress(pct);
            btnSyncNow.setEnabled(false);
            btnSyncNow.setText("Syncing (" + pct + "%)...");
        } else {
            progressBar.setVisibility(View.GONE);
            btnSyncNow.setEnabled(true);
            btnSyncNow.setText("🔄 Sync Photos Now");
        }
    }
}
