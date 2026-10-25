import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { pingServer, discoverDesktopOnWifi } from './discovery';

export const BACKGROUND_SYNC_TASK = 'HOMECLOUD_WIFI_AUTO_SYNC';

const STORAGE_KEYS = {
  DEVICE_ID: 'hc_device_id',
  PAIRED_SERVER: 'hc_paired_server',
  SYNC_SETTINGS: 'hc_sync_settings',
  SYNCED_IDS: 'hc_synced_asset_ids',
  LAST_SYNC_SUMMARY: 'hc_last_sync_summary'
};

let isSyncRunning = false;

export async function getOrCreateDeviceId() {
  let id = await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_ID);
  if (!id) {
    id = 'android-' + Math.random().toString(36).substring(2, 10);
    await AsyncStorage.setItem(STORAGE_KEYS.DEVICE_ID, id);
  }
  return id;
}

export function getDeviceName() {
  return Device.deviceName || Device.modelName || 'Android Phone';
}

export async function getPairedServer() {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.PAIRED_SERVER);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

export async function savePairedServer(serverObj) {
  await AsyncStorage.setItem(STORAGE_KEYS.PAIRED_SERVER, JSON.stringify(serverObj));
}

export async function clearPairedServer() {
  await AsyncStorage.removeItem(STORAGE_KEYS.PAIRED_SERVER);
}

export async function getSyncSettings() {
  const defaults = {
    autoSyncOnWifi: true,
    includeVideos: true,
    keepBackupOnDelete: true,
    scanLimit: 250
  };
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.SYNC_SETTINGS);
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch (_e) {
    return defaults;
  }
}

export async function saveSyncSettings(settings) {
  await AsyncStorage.setItem(STORAGE_KEYS.SYNC_SETTINGS, JSON.stringify(settings));
}

export async function getLastSyncSummary() {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC_SUMMARY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

async function getLocalSyncedSet() {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.SYNCED_IDS);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw));
  } catch (_e) {
    return new Set();
  }
}

async function saveLocalSyncedSet(setObj) {
  const arr = Array.from(setObj).slice(-5000);
  await AsyncStorage.setItem(STORAGE_KEYS.SYNCED_IDS, JSON.stringify(arr));
}

/**
 * Pairs with a discovered or QR-scanned HomeCloud Desktop server
 */
export async function pairWithDesktop(serverInfo) {
  const deviceId = await getOrCreateDeviceId();
  const deviceName = getDeviceName();
  const port = serverInfo.port || 4820;
  const ip = serverInfo.ip;

  const res = await fetch(`http://${ip}:${port}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      deviceName,
      platform: 'Android',
      pairCode: serverInfo.pairCode || ''
    })
  });

  if (!res.ok) {
    throw new Error('Failed to pair with Desktop server');
  }

  const data = await res.json();
  const paired = {
    serverId: data.serverId || serverInfo.serverId,
    serverName: data.serverName || serverInfo.serverName || 'HomeCloud-PC',
    ip,
    ips: serverInfo.ips || [ip],
    port,
    pairCode: serverInfo.pairCode || '',
    token: data.token,
    pairedAt: new Date().toISOString()
  };

  await savePairedServer(paired);
  return paired;
}

/**
 * Verifies if the Desktop server is reachable on the current Wi-Fi.
 * Zero-Touch Auto-Connect: Even if never paired before, automatically discovers the Desktop PC
 * on the local Wi-Fi subnet and pairs silently with zero QR scanning required.
 */
export async function verifyHomeCloudConnection() {
  const netState = await Network.getNetworkStateAsync();
  if (!netState.isConnected || netState.type !== Network.NetworkStateType.WIFI) {
    const paired = await getPairedServer();
    return { reachable: false, reason: 'not_on_wifi', paired };
  }

  let paired = await getPairedServer();

  // 1. If already paired, try primary saved IP first
  if (paired && paired.ip) {
    const direct = await pingServer(paired.ip, paired.port || 4820, 900);
    if (direct) {
      return { reachable: true, server: { ...paired, ...direct } };
    }

    // 2. Try alternate IPs if any
    if (Array.isArray(paired.ips)) {
      for (const altIp of paired.ips) {
        if (altIp === paired.ip) continue;
        const hit = await pingServer(altIp, paired.port || 4820, 750);
        if (hit) {
          const updated = { ...paired, ip: altIp, serverName: hit.serverName || paired.serverName };
          await savePairedServer(updated);
          return { reachable: true, server: updated };
        }
      }
    }
  }

  // 3. Zero-Touch Auto-Discovery on Wi-Fi (works on first launch & background wakeups without QR scan!)
  const discovered = await discoverDesktopOnWifi(paired?.port || 4820);
  if (discovered) {
    try {
      const autoPaired = await pairWithDesktop(discovered);
      return { reachable: true, server: autoPaired };
    } catch (_e) {
      await savePairedServer(discovered);
      return { reachable: true, server: discovered };
    }
  }

  return { reachable: false, reason: 'desktop_unreachable_on_this_wifi', paired };
}

/**
 * Core Auto-Sync routine:
 * Checks Wi-Fi + Desktop reachability, inspects Camera Roll, deduplicates with server, and uploads new media.
 */
export async function runPhotoSync({ manual = false, onStatusChange = null } = {}) {
  if (isSyncRunning) {
    return { skipped: true, reason: 'already_running' };
  }

  const emit = (state) => {
    if (onStatusChange) onStatusChange(state);
  };

  try {
    isSyncRunning = true;
    const settings = await getSyncSettings();
    if (!manual && !settings.autoSyncOnWifi) {
      isSyncRunning = false;
      return { skipped: true, reason: 'auto_sync_disabled' };
    }

    emit({ phase: 'checking_wifi', message: 'Checking Home Wi-Fi connection...' });
    const conn = await verifyHomeCloudConnection();
    if (!conn.reachable) {
      isSyncRunning = false;
      emit({ phase: 'idle', message: 'Waiting for Home Wi-Fi & Desktop Server...' });
      return { skipped: true, reason: conn.reason };
    }

    const server = conn.server;
    const baseUrl = `http://${server.ip}:${server.port || 4820}`;
    const deviceId = await getOrCreateDeviceId();
    const deviceName = getDeviceName();

    // Check MediaLibrary permissions
    const perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted) {
      if (manual) {
        const req = await MediaLibrary.requestPermissionsAsync();
        if (!req.granted) {
          isSyncRunning = false;
          emit({ phase: 'error', message: 'Photo library permission is required to sync.' });
          return { skipped: true, reason: 'permission_denied' };
        }
      } else {
        isSyncRunning = false;
        return { skipped: true, reason: 'permission_not_granted' };
      }
    }

    emit({
      phase: 'scanning',
      message: `Connected to ${server.serverName}. Scanning camera roll...`
    });

    const mediaTypes = settings.includeVideos
      ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
      : [MediaLibrary.MediaType.photo];

    const assetsPage = await MediaLibrary.getAssetsAsync({
      first: settings.scanLimit || 250,
      mediaType: mediaTypes,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]]
    });

    const allAssets = assetsPage.assets || [];
    if (allAssets.length === 0) {
      isSyncRunning = false;
      emit({ phase: 'completed', message: 'No photos found in library.' });
      return { uploaded: 0, total: 0 };
    }

    const localSyncedSet = await getLocalSyncedSet();
    const candidates = allAssets.filter((a) => !localSyncedSet.has(a.id));

    if (candidates.length === 0) {
      isSyncRunning = false;
      emit({ phase: 'completed', message: 'All recent photos are already backed up!' });
      return { uploaded: 0, total: allAssets.length };
    }

    // Ask Desktop Server which candidate assets are not yet in the vault
    const checkRes = await fetch(`${baseUrl}/api/check-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        assets: candidates.map((a) => ({
          id: a.id,
          filename: a.filename,
          creationTime: a.creationTime
        }))
      })
    });

    const checkData = await checkRes.json();
    const unsyncedSet = new Set(checkData.unsyncedIds || []);

    // Mark already-synced items in local cache too
    for (const c of candidates) {
      if (!unsyncedSet.has(c.id)) {
        localSyncedSet.add(c.id);
      }
    }
    await saveLocalSyncedSet(localSyncedSet);

    const toUpload = candidates.filter((a) => unsyncedSet.has(a.id));
    if (toUpload.length === 0) {
      isSyncRunning = false;
      const summary = {
        lastSyncedAt: new Date().toISOString(),
        uploadedCount: 0,
        checkedCount: allAssets.length,
        serverName: server.serverName
      };
      await AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC_SUMMARY, JSON.stringify(summary));
      emit({
        phase: 'completed',
        message: 'Everything is up to date with HomeCloud Desktop!',
        summary
      });
      return { uploaded: 0, total: allAssets.length };
    }

    // Upload unsynced photos oldest-to-newest so gallery fills chronologically
    const uploadQueue = [...toUpload].reverse();
    let uploadedCount = 0;

    for (let i = 0; i < uploadQueue.length; i++) {
      const asset = uploadQueue[i];
      const currentNum = i + 1;

      emit({
        phase: 'uploading',
        current: currentNum,
        total: uploadQueue.length,
        filename: asset.filename,
        message: `Backing up ${currentNum} of ${uploadQueue.length}: ${asset.filename}`
      });

      // Notify desktop live progress banner
      fetch(`${baseUrl}/api/sync-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          deviceName,
          status: 'syncing',
          current: currentNum,
          total: uploadQueue.length,
          lastFile: asset.filename
        })
      }).catch(() => {});

      // Resolve local file URI via getAssetInfoAsync
      let fileUri = asset.uri;
      try {
        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
        if (assetInfo && assetInfo.localUri) {
          fileUri = assetInfo.localUri;
        }
      } catch (_e) {}

      const uploadResult = await FileSystem.uploadAsync(`${baseUrl}/api/upload`, fileUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        parameters: {
          assetId: String(asset.id),
          deviceId,
          deviceName,
          originalName: asset.filename || `IMG_${Date.now()}.jpg`,
          capturedAt: String(asset.creationTime || Date.now()),
          mediaType: asset.mediaType === 'video' ? 'video' : 'photo',
          width: String(asset.width || 0),
          height: String(asset.height || 0),
          duration: String(asset.duration || 0)
        }
      });

      if (uploadResult.status >= 200 && uploadResult.status < 300) {
        uploadedCount++;
        localSyncedSet.add(asset.id);
        await saveLocalSyncedSet(localSyncedSet);
      }
    }

    // Clear live progress banner on desktop
    fetch(`${baseUrl}/api/sync-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName,
        status: 'completed'
      })
    }).catch(() => {});

    const summary = {
      lastSyncedAt: new Date().toISOString(),
      uploadedCount,
      checkedCount: allAssets.length,
      serverName: server.serverName
    };
    await AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC_SUMMARY, JSON.stringify(summary));

    isSyncRunning = false;
    emit({
      phase: 'completed',
      message: `Backed up ${uploadedCount} new ${uploadedCount === 1 ? 'item' : 'items'} to ${server.serverName}!`,
      summary
    });
    return { uploaded: uploadedCount, total: allAssets.length, summary };
  } catch (err) {
    isSyncRunning = false;
    emit({
      phase: 'error',
      message: `Sync interrupted: ${err.message || 'Network error'}`
    });
    return { error: err.message };
  }
}

// Define Background Fetch Task so Android runs Wi-Fi auto-sync in the background
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const res = await runPhotoSync({ manual: false });
    if (res && res.uploaded > 0) {
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (_e) {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundAutoSync() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: 15 * 60, // 15 minutes background check + instant NetInfo Wi-Fi listener
        stopOnTerminate: false,
        startOnBoot: true
      });
    }
  } catch (e) {
    // In Expo Go or web, background fetch registration may warn harmlessly
    console.log('Background task note:', e.message);
  }
}
