import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Switch,
  TextInput,
  FlatList,
  Image,
  AppState,
  ActivityIndicator,
  SafeAreaView
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import NetInfo from '@react-native-community/netinfo';
import * as MediaLibrary from 'expo-media-library';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { discoverDesktopOnWifi, pingServer } from './src/services/discovery';
import {
  getPairedServer,
  pairWithDesktop,
  clearPairedServer,
  getSyncSettings,
  saveSyncSettings,
  getLastSyncSummary,
  verifyHomeCloudConnection,
  runPhotoSync,
  registerBackgroundAutoSync
} from './src/services/syncEngine';

export default function App() {
  const [pairedServer, setPairedServer] = useState(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [wifiConnected, setWifiConnected] = useState(false);

  const [settings, setSettings] = useState({
    autoSyncOnWifi: true,
    includeVideos: true,
    scanLimit: 250
  });
  const [lastSummary, setLastSummary] = useState(null);
  const [syncState, setSyncState] = useState({
    phase: 'idle',
    message: 'Ready to sync on Home Wi-Fi'
  });

  const [discovering, setDiscovering] = useState(false);
  const [discoverProgress, setDiscoverProgress] = useState(0);
  const [manualIp, setManualIp] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);

  const [scanningQr, setScanningQr] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [recentPhotos, setRecentPhotos] = useState([]);
  const lastWifiTriggerRef = useRef(0);

  useEffect(() => {
    initializeApp();

    // Listen for Wi-Fi connection events to trigger automatic backup
    const unsubscribeNet = NetInfo.addEventListener(async (state) => {
      const onWifi = Boolean(state.isConnected && state.type === 'wifi');
      setWifiConnected(onWifi);

      if (onWifi) {
        const now = Date.now();
        // Debounce rapid NetInfo events within 8 seconds
        if (now - lastWifiTriggerRef.current > 8000) {
          lastWifiTriggerRef.current = now;
          await checkServerAndAutoSync();
        }
      } else {
        setServerOnline(false);
      }
    });

    // Also check when app comes to foreground
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        checkServerAndAutoSync();
        loadRecentCameraRoll();
      }
    });

    // Listen for newly captured photos on the phone and auto-sync immediately on Wi-Fi
    const mediaSub = MediaLibrary.addListener(() => {
      loadRecentCameraRoll();
      checkServerAndAutoSync();
    });

    // Periodic heartbeat every 25s so if PC wakes up while phone is already on Wi-Fi, it auto-connects
    const intervalId = setInterval(() => {
      checkServerAndAutoSync();
    }, 25000);

    return () => {
      unsubscribeNet();
      appStateSub.remove();
      mediaSub.remove();
      clearInterval(intervalId);
    };
  }, []);

  async function initializeApp() {
    await registerBackgroundAutoSync();
    const savedServer = await getPairedServer();
    const savedSettings = await getSyncSettings();
    const summary = await getLastSyncSummary();

    setPairedServer(savedServer);
    setSettings(savedSettings);
    setLastSummary(summary);

    await loadRecentCameraRoll();
    await checkServerAndAutoSync();
  }

  async function loadRecentCameraRoll() {
    try {
      const perm = await MediaLibrary.getPermissionsAsync();
      if (!perm.granted) {
        const req = await MediaLibrary.requestPermissionsAsync();
        if (!req.granted) return;
      }
      const res = await MediaLibrary.getAssetsAsync({
        first: 18,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]]
      });
      setRecentPhotos(res.assets || []);
    } catch (_e) {}
  }

  async function checkServerAndAutoSync() {
    const conn = await verifyHomeCloudConnection();
    if (conn.reachable && conn.server) {
      setPairedServer(conn.server);
      setServerOnline(true);

      const currentSettings = await getSyncSettings();
      if (currentSettings.autoSyncOnWifi) {
        triggerSync(false);
      }
    } else {
      setServerOnline(false);
    }
  }

  async function triggerSync(manual = true) {
    const res = await runPhotoSync({
      manual,
      onStatusChange: (status) => {
        setSyncState(status);
        if (status.summary) {
          setLastSummary(status.summary);
        }
      }
    });
    if (res && res.summary) {
      setLastSummary(res.summary);
    }
    loadRecentCameraRoll();
  }

  async function handleAutoDiscover() {
    setDiscovering(true);
    setDiscoverProgress(5);
    setSyncState({ phase: 'scanning', message: 'Searching local Wi-Fi for HomeCloud Desktop...' });

    try {
      const found = await discoverDesktopOnWifi(4820, (pct) => setDiscoverProgress(pct));
      if (found) {
        const paired = await pairWithDesktop(found);
        setPairedServer(paired);
        setServerOnline(true);
        setDiscovering(false);
        triggerSync(true);
      } else {
        setDiscovering(false);
        setSyncState({
          phase: 'error',
          message: 'No Desktop found automatically. Try QR Scan or enter the IP shown on your PC.'
        });
      }
    } catch (err) {
      setDiscovering(false);
      setSyncState({ phase: 'error', message: err.message || 'Discovery failed' });
    }
  }

  async function handleManualPair() {
    const cleaned = manualIp.trim().replace(/^https?:\/\//i, '').split('/')[0];
    if (!cleaned) return;
    const [ipPart, portPart] = cleaned.split(':');
    const port = portPart ? Number(portPart) : 4820;

    setDiscovering(true);
    const hit = await pingServer(ipPart, port, 2500);
    if (!hit) {
      setDiscovering(false);
      setSyncState({
        phase: 'error',
        message: `Could not reach HomeCloud Desktop at ${ipPart}:${port}. Verify both devices are on the same Wi-Fi.`
      });
      return;
    }

    try {
      const paired = await pairWithDesktop(hit);
      setPairedServer(paired);
      setServerOnline(true);
      setDiscovering(false);
      setShowManualInput(false);
      triggerSync(true);
    } catch (err) {
      setDiscovering(false);
      setSyncState({ phase: 'error', message: err.message });
    }
  }

  async function startQrScanner() {
    if (!cameraPermission?.granted) {
      const res = await requestCameraPermission();
      if (!res.granted) return;
    }
    setScanningQr(true);
  }

  async function handleBarcodeScanned({ data }) {
    if (!scanningQr) return;
    setScanningQr(false);
    try {
      const parsed = JSON.parse(data);
      if (parsed && parsed.ip) {
        const paired = await pairWithDesktop(parsed);
        setPairedServer(paired);
        setServerOnline(true);
        triggerSync(true);
      }
    } catch (_e) {
      // Check if it's a direct http://IP:4820 URL
      if (data && data.startsWith('http')) {
        const cleaned = data.replace(/^https?:\/\//i, '').split('/')[0];
        const [ip, port] = cleaned.split(':');
        const hit = await pingServer(ip, Number(port) || 4820, 2000);
        if (hit) {
          const paired = await pairWithDesktop(hit);
          setPairedServer(paired);
          setServerOnline(true);
          triggerSync(true);
        }
      }
    }
  }

  async function toggleSetting(key, value) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    await saveSyncSettings(next);
    if (key === 'autoSyncOnWifi' && value && serverOnline) {
      triggerSync(false);
    }
  }

  async function handleUnpair() {
    await clearPairedServer();
    setPairedServer(null);
    setServerOnline(false);
  }

  if (scanningQr) {
    return (
      <SafeAreaView style={styles.qrContainer}>
        <StatusBar style="light" />
        <View style={styles.qrHeader}>
          <Text style={styles.qrTitle}>Scan HomeCloud Desktop QR</Text>
          <TouchableOpacity style={styles.btnCancelQr} onPress={() => setScanningQr(false)}>
            <Text style={styles.btnCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.qrFooter}>
          <Text style={styles.qrHint}>
            Open HomeCloud on your PC → Click "Connect Phone (QR)" and point your camera at the code.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const isUploading = syncState.phase === 'uploading' || syncState.phase === 'scanning';
  const progressPct =
    syncState.total > 0 ? Math.round(((syncState.current || 0) / syncState.total) * 100) : 0;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* App Header */}
        <View style={styles.header}>
          <View style={styles.brandIcon}>
            <Text style={styles.brandEmoji}>☁️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.brandTitle}>HomeCloud Sync</Text>
            <Text style={styles.brandSubtitle}>Automatic Wi-Fi Photo & Video Vault</Text>
          </View>
          <View style={[styles.wifiBadge, wifiConnected ? styles.wifiOn : styles.wifiOff]}>
            <Text style={styles.wifiBadgeText}>{wifiConnected ? 'Wi-Fi ON' : 'No Wi-Fi'}</Text>
          </View>
        </View>

        {/* Connection / Pairing Card */}
        {!pairedServer ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>1-Step Minimal Setup</Text>
            <Text style={styles.cardDesc}>
              Connect your phone to the same Wi-Fi as your Desktop PC. Once paired, your photos back up automatically whenever you join home Wi-Fi.
            </Text>

            <TouchableOpacity
              style={styles.btnPrimary}
              onPress={handleAutoDiscover}
              disabled={discovering}
            >
              {discovering ? (
                <View style={styles.rowCenter}>
                  <ActivityIndicator color="#fff" style={{ marginRight: 10 }} />
                  <Text style={styles.btnPrimaryText}>
                    Scanning Wi-Fi ({discoverProgress}%)...
                  </Text>
                </View>
              ) : (
                <Text style={styles.btnPrimaryText}>⚡ Auto-Find Desktop on Wi-Fi</Text>
              )}
            </TouchableOpacity>

            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.btnSecondaryHalf} onPress={startQrScanner}>
                <Text style={styles.btnSecondaryText}>📷 Scan Desktop QR</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.btnSecondaryHalf}
                onPress={() => setShowManualInput(!showManualInput)}
              >
                <Text style={styles.btnSecondaryText}>⌨️ Enter Desktop IP</Text>
              </TouchableOpacity>
            </View>

            {showManualInput && (
              <View style={styles.manualBox}>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 192.168.1.50:4820"
                  placeholderTextColor="#64748b"
                  value={manualIp}
                  onChangeText={setManualIp}
                  autoCapitalize="none"
                  keyboardType="numbers-and-punctuation"
                />
                <TouchableOpacity style={styles.btnConnectIp} onPress={handleManualPair}>
                  <Text style={styles.btnPrimaryText}>Connect</Text>
                </TouchableOpacity>
              </View>
            )}

            {syncState.phase === 'error' && (
              <Text style={styles.errorText}>{syncState.message}</Text>
            )}
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.serverRow}>
              <View style={[styles.dot, serverOnline ? styles.dotOnline : styles.dotOffline]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.serverTitle}>{pairedServer.serverName}</Text>
                <Text style={styles.serverMeta}>
                  {serverOnline
                    ? `Connected on Same Wi-Fi (${pairedServer.ip}:${pairedServer.port || 4820})`
                    : 'Waiting for Home Wi-Fi / Desktop offline'}
                </Text>
              </View>
              <TouchableOpacity onPress={handleUnpair}>
                <Text style={styles.unpairLink}>Change PC</Text>
              </TouchableOpacity>
            </View>

            {/* Sync Status & Progress */}
            <View style={styles.syncStatusBox}>
              <Text style={styles.syncStatusText}>{syncState.message}</Text>
              {isUploading && (
                <View style={styles.progressBarBg}>
                  <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
                </View>
              )}
              {lastSummary && (
                <Text style={styles.lastSyncMeta}>
                  Last sync: {new Date(lastSummary.lastSyncedAt).toLocaleTimeString()} • Checked{' '}
                  {lastSummary.checkedCount} items
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[styles.btnPrimary, isUploading && { opacity: 0.65 }]}
              onPress={() => triggerSync(true)}
              disabled={isUploading}
            >
              <Text style={styles.btnPrimaryText}>
                {isUploading ? 'Syncing Photos...' : '🔄 Sync Now'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Auto-Sync Settings Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Automatic Wi-Fi Sync Rules</Text>

          <View style={styles.settingRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.settingName}>Auto-Sync on Same Wi-Fi</Text>
              <Text style={styles.settingSub}>
                Automatically upload new photos when your phone connects to your home Wi-Fi
              </Text>
            </View>
            <Switch
              value={settings.autoSyncOnWifi}
              onValueChange={(v) => toggleSetting('autoSyncOnWifi', v)}
              trackColor={{ false: '#334155', true: '#0284c7' }}
              thumbColor="#f8fafc"
            />
          </View>

          <View style={styles.settingRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.settingName}>Include Videos</Text>
              <Text style={styles.settingSub}>
                Back up camera roll videos alongside photos into YYYY/MM folders
              </Text>
            </View>
            <Switch
              value={settings.includeVideos}
              onValueChange={(v) => toggleSetting('includeVideos', v)}
              trackColor={{ false: '#334155', true: '#0284c7' }}
              thumbColor="#f8fafc"
            />
          </View>

          <View style={[styles.settingRow, { borderBottomWidth: 0 }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.settingName, { color: '#4ade80' }]}>
                Keep PC Backup Safe If Deleted on Phone
              </Text>
              <Text style={styles.settingSub}>
                Deleting photos on your phone will NOT delete them from D:\Phone Backup\Cloud unless turned off
              </Text>
            </View>
            <Switch
              value={settings.keepBackupOnDelete !== false}
              onValueChange={(v) => toggleSetting('keepBackupOnDelete', v)}
              trackColor={{ false: '#334155', true: '#22c55e' }}
              thumbColor="#f8fafc"
            />
          </View>
        </View>

        {/* Recent Camera Roll Preview */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Camera Roll ({recentPhotos.length})</Text>
          <FlatList
            data={recentPhotos}
            keyExtractor={(item) => item.id}
            numColumns={3}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={styles.thumbWrap}>
                <Image source={{ uri: item.uri }} style={styles.thumb} />
                {item.mediaType === 'video' && (
                  <View style={styles.videoBadge}>
                    <Text style={styles.videoBadgeText}>▶</Text>
                  </View>
                )}
              </View>
            )}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#090d16'
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
    marginTop: 8
  },
  brandIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  brandEmoji: {
    fontSize: 22
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc'
  },
  brandSubtitle: {
    fontSize: 12,
    color: '#94a3b8'
  },
  wifiBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14
  },
  wifiOn: {
    backgroundColor: 'rgba(34, 197, 94, 0.18)'
  },
  wifiOff: {
    backgroundColor: 'rgba(244, 63, 94, 0.18)'
  },
  wifiBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#f8fafc'
  },
  card: {
    backgroundColor: '#111827',
    borderColor: '#1f2937',
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    marginBottom: 16
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 6
  },
  cardDesc: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 19,
    marginBottom: 16
  },
  btnPrimary: {
    backgroundColor: '#0284c7',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  btnPrimaryText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700'
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10
  },
  btnSecondaryHalf: {
    flex: 1,
    backgroundColor: '#1e293b',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center'
  },
  btnSecondaryText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600'
  },
  manualBox: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12
  },
  input: {
    flex: 1,
    backgroundColor: '#090d16',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    fontSize: 14
  },
  btnConnectIp: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 16,
    borderRadius: 10,
    justifyContent: 'center'
  },
  errorText: {
    color: '#fb7185',
    fontSize: 12.5,
    marginTop: 10
  },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10
  },
  dotOnline: {
    backgroundColor: '#22c55e'
  },
  dotOffline: {
    backgroundColor: '#f59e0b'
  },
  serverTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc'
  },
  serverMeta: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2
  },
  unpairLink: {
    color: '#38bdf8',
    fontSize: 12.5,
    fontWeight: '600'
  },
  syncStatusBox: {
    backgroundColor: '#161f33',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14
  },
  syncStatusText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600'
  },
  progressBarBg: {
    height: 7,
    backgroundColor: '#334155',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 8
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#38bdf8'
  },
  lastSyncMeta: {
    color: '#94a3b8',
    fontSize: 11.5,
    marginTop: 6
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1
  },
  settingName: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600'
  },
  settingSub: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2
  },
  thumbWrap: {
    flex: 1 / 3,
    aspectRatio: 1,
    padding: 3,
    position: 'relative'
  },
  thumb: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
    backgroundColor: '#1e293b'
  },
  videoBadge: {
    position: 'absolute',
    right: 8,
    top: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2
  },
  videoBadgeText: {
    color: '#fff',
    fontSize: 10
  },
  qrContainer: {
    flex: 1,
    backgroundColor: '#000'
  },
  qrHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#111827'
  },
  qrTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700'
  },
  btnCancelQr: {
    padding: 6
  },
  btnCancelText: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '600'
  },
  camera: {
    flex: 1
  },
  qrFooter: {
    padding: 20,
    backgroundColor: '#111827'
  },
  qrHint: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center'
  }
});
