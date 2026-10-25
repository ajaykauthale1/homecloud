let currentFilter = 'all';
let currentView = 'gallery';
let currentSearch = '';
let serverInfo = null;
let mediaItems = [];
let activeLightboxItem = null;
let qrMode = 'native'; // 'native' or 'web'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatYearMonth(ym) {
  if (!ym || !ym.includes('-')) return ym || 'Unknown Date';
  const [y, m] = ym.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES[monthIdx] || m} ${y}`;
}

async function refreshAll() {
  serverInfo = await window.homecloud.getServerInfo();
  updateServerUI(serverInfo);
  await loadGallery();
}

function updateServerUI(info) {
  if (!info) return;
  serverInfo = info;

  document.getElementById('sidebarServerIp').textContent = `${info.primaryIP}:${info.port}`;
  document.getElementById('sidebarStoragePath').textContent = info.storageDir;
  document.getElementById('settingsStorageDir').textContent = info.storageDir;
  const pathInput = document.getElementById('inputStoragePath');
  if (pathInput && document.activeElement !== pathInput) {
    pathInput.value = info.storageDir;
  }
  document.getElementById('toggleOrganizeByDate').checked = Boolean(info.organizeByDate);
  const devToggle = document.getElementById('toggleOrganizeByDevice');
  if (devToggle) {
    devToggle.checked = Boolean(info.organizeByDevice);
  }
  const protectToggle = document.getElementById('toggleProtectFromPhoneDelete');
  if (protectToggle) {
    protectToggle.checked = info.protectFromPhoneDelete !== false;
  }
  document.getElementById('viewSubtitle').textContent = info.organizeByDate
    ? 'Organized by YYYY/MM'
    : 'Flat Folder Storage';

  // Badges & Stats
  if (info.stats) {
    document.getElementById('badgeAll').textContent = info.stats.totalCount;
    document.getElementById('badgePhotos').textContent = info.stats.photoCount;
    document.getElementById('badgeVideos').textContent = info.stats.videoCount;
    document.getElementById('sidebarTotalSize').textContent = formatBytes(info.stats.totalBytes);
  }

  // Pairing QR & Info
  document.getElementById('infoServerName').textContent = info.serverName;
  document.getElementById('infoServerUrl').textContent = info.serverUrl;
  document.getElementById('infoPairCode').textContent = info.pairCode;
  document.getElementById('infoMobileWebUrl').textContent = info.mobileWebUrl;

  const qrImg = document.getElementById('qrImage');
  qrImg.src = qrMode === 'native' ? info.qrDataUrl : info.webQrDataUrl;

  // Network Interfaces
  const netListEl = document.getElementById('settingsNetworkList');
  if (info.allIPs && info.allIPs.length > 0) {
    netListEl.innerHTML = info.allIPs
      .map((n) => `<code>${n.address}</code> (${n.name})`)
      .join(' &bull; ');
  } else {
    netListEl.textContent = info.primaryIP;
  }

  // Paired Devices
  const devices = info.pairedDevices || [];
  document.getElementById('badgeDevices').textContent = devices.length;
  const devicesListEl = document.getElementById('devicesList');
  if (devices.length === 0) {
    devicesListEl.innerHTML = `
      <div class="device-row">
        <div>
          <div class="device-name">No phones paired yet</div>
          <div class="device-meta">Scan the QR code or use Auto-Find in the Android app on the same Wi-Fi.</div>
        </div>
      </div>
    `;
  } else {
    devicesListEl.innerHTML = devices
      .map((d) => {
        const lastSeen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'Recently';
        return `
        <div class="device-row">
          <div>
            <div class="device-name">📱 ${d.deviceName || 'Android Phone'}</div>
            <div class="device-meta">Last active on Wi-Fi: ${lastSeen} (${d.ip || 'LAN'})</div>
          </div>
          <div class="device-stats">
            ${d.totalSynced || 0} backed up
          </div>
        </div>
      `;
      })
      .join('');
  }

  // Active Syncs
  updateLiveSyncBanner(info.activeSyncs || []);
}

function updateLiveSyncBanner(activeSyncs) {
  const card = document.getElementById('liveSyncCard');
  if (!activeSyncs || activeSyncs.length === 0) {
    card.classList.add('hidden');
    return;
  }
  const sync = activeSyncs[0];
  card.classList.remove('hidden');
  document.getElementById('liveSyncDevice').textContent = `Syncing ${sync.deviceName || 'Phone'}...`;
  const pct = sync.total > 0 ? Math.min(100, Math.round((sync.current / sync.total) * 100)) : 50;
  document.getElementById('liveSyncBar').style.width = `${pct}%`;
  document.getElementById('liveSyncMeta').textContent =
    `${sync.current} / ${sync.total} (${sync.lastFile || 'uploading...'})`;
}

async function loadGallery() {
  const res = await window.homecloud.getMedia({
    filter: currentFilter,
    search: currentSearch
  });
  mediaItems = res.items || [];
  const serverUrl = res.serverUrl || (serverInfo && serverInfo.serverUrl) || 'http://127.0.0.1:4820';

  if (res.stats) {
    document.getElementById('badgeAll').textContent = res.stats.totalCount;
    document.getElementById('badgePhotos').textContent = res.stats.photoCount;
    document.getElementById('badgeVideos').textContent = res.stats.videoCount;
    document.getElementById('sidebarTotalSize').textContent = formatBytes(res.stats.totalBytes);
  }

  const container = document.getElementById('galleryContainer');
  if (mediaItems.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
        </div>
        <h3>Your HomeCloud Vault is Ready</h3>
        <p>When your mobile phone connects to the same Wi-Fi network, new photos and videos will automatically sync into <strong>${serverInfo ? serverInfo.storageDir : '~/Pictures/HomeCloud'}</strong>.</p>
        <button class="btn-primary" id="btnEmptyPair">Pair Mobile Phone Now</button>
      </div>
    `;
    const btnEmpty = document.getElementById('btnEmptyPair');
    if (btnEmpty) {
      btnEmpty.addEventListener('click', () => switchView('devices'));
    }
    return;
  }

  // Group items by yearMonth (YYYY-MM)
  const groups = new Map();
  for (const item of mediaItems) {
    const ym = item.yearMonth || 'Recent';
    if (!groups.has(ym)) groups.set(ym, []);
    groups.get(ym).push(item);
  }

  let html = '';
  for (const [ym, items] of groups.entries()) {
    html += `
      <div class="month-group">
        <div class="month-header">
          <div class="month-title">${formatYearMonth(ym)}</div>
          <div class="month-count">${items.length} ${items.length === 1 ? 'item' : 'items'}</div>
        </div>
        <div class="media-grid">
          ${items
            .map((item) => {
              const mediaSrc = `${serverUrl}/media/${encodeURI(item.relativePath)}`;
              const dateStr = new Date(item.capturedAt).toLocaleDateString();
              const isVid = item.mediaType === 'video';
              return `
                <div class="media-card" data-id="${item.id}">
                  ${
                    isVid
                      ? `<video src="${mediaSrc}#t=0.5" preload="metadata" muted></video>
                         <div class="media-badge-video">▶ Video</div>`
                      : `<img src="${mediaSrc}" loading="lazy" alt="${item.filename}" />`
                  }
                  ${item.favorite ? `<div class="media-fav-indicator">♥</div>` : ''}
                  <div class="media-overlay">
                    <span>${dateStr}</span>
                    <span>${formatBytes(item.size)}</span>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.media-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const item = mediaItems.find((i) => i.id === id);
      if (item) openLightbox(item, serverUrl);
    });
  });
}

function openLightbox(item, serverUrl) {
  activeLightboxItem = item;
  const lb = document.getElementById('lightbox');
  const stage = document.getElementById('lightboxStage');
  const title = document.getElementById('lightboxTitle');
  const meta = document.getElementById('lightboxMeta');
  const favBtn = document.getElementById('lightboxFavBtn');

  const mediaSrc = `${serverUrl}/media/${encodeURI(item.relativePath)}`;
  title.textContent = item.filename;
  favBtn.classList.toggle('fav-active', Boolean(item.favorite));

  if (item.mediaType === 'video') {
    stage.innerHTML = `<video src="${mediaSrc}" controls autoplay></video>`;
  } else {
    stage.innerHTML = `<img src="${mediaSrc}" alt="${item.filename}" />`;
  }

  const captured = new Date(item.capturedAt).toLocaleString();
  meta.textContent = `Captured: ${captured}  •  Size: ${formatBytes(item.size)}  •  Device: ${item.deviceName || 'Mobile'}  •  Path: ${item.relativePath}`;

  lb.classList.remove('hidden');
}

function closeLightbox() {
  activeLightboxItem = null;
  const lb = document.getElementById('lightbox');
  const stage = document.getElementById('lightboxStage');
  stage.innerHTML = '';
  lb.classList.add('hidden');
}

function switchView(viewName, filterName = null) {
  currentView = viewName;
  if (filterName) currentFilter = filterName;

  document.querySelectorAll('.nav-item').forEach((btn) => {
    const v = btn.getAttribute('data-view');
    const f = btn.getAttribute('data-filter');
    if (viewName === 'gallery') {
      btn.classList.toggle('active', v === 'gallery' && f === currentFilter);
    } else {
      btn.classList.toggle('active', v === viewName);
    }
  });

  document.getElementById('viewGallery').classList.toggle('active', viewName === 'gallery');
  document.getElementById('viewDevices').classList.toggle('active', viewName === 'devices');
  document.getElementById('viewSettings').classList.toggle('active', viewName === 'settings');
  document.getElementById('searchBoxWrap').classList.toggle('hidden', viewName !== 'gallery');

  const titleEl = document.getElementById('viewTitle');
  if (viewName === 'gallery') {
    const titles = {
      all: 'All Media',
      photos: 'Photos',
      videos: 'Videos',
      favorites: 'Favorites'
    };
    titleEl.textContent = titles[currentFilter] || 'Gallery';
    loadGallery();
  } else if (viewName === 'devices') {
    titleEl.textContent = 'Mobile Pairing & Connected Phones';
  } else if (viewName === 'settings') {
    titleEl.textContent = 'Storage & Backup Settings';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Nav clicks
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view');
      const f = btn.getAttribute('data-filter');
      switchView(v, f);
    });
  });

  document.getElementById('btnQuickPair').addEventListener('click', () => {
    switchView('devices');
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    loadGallery();
  });

  document.getElementById('btnOpenFolder').addEventListener('click', () => {
    window.homecloud.openStorageFolder();
  });
  document.getElementById('btnOpenFolder2').addEventListener('click', () => {
    window.homecloud.openStorageFolder();
  });
  document.getElementById('sidebarStoragePath').addEventListener('click', () => {
    window.homecloud.openStorageFolder();
  });

  document.getElementById('btnRescan').addEventListener('click', async () => {
    const info = await window.homecloud.rescanFolder();
    updateServerUI(info);
    await loadGallery();
  });

  document.getElementById('btnChangeFolder').addEventListener('click', async () => {
    const info = await window.homecloud.chooseStorageFolder();
    if (info) {
      updateServerUI(info);
      await loadGallery();
    }
  });

  document.getElementById('btnSaveStoragePath').addEventListener('click', async () => {
    const customPath = document.getElementById('inputStoragePath').value.trim();
    if (customPath) {
      const info = await window.homecloud.setStorageFolderPath(customPath);
      if (info) {
        updateServerUI(info);
        await loadGallery();
      }
    }
  });

  document.getElementById('toggleProtectFromPhoneDelete').addEventListener('change', async (e) => {
    const info = await window.homecloud.setProtectFromPhoneDelete(e.target.checked);
    updateServerUI(info);
  });

  document.getElementById('toggleOrganizeByDate').addEventListener('change', async (e) => {
    const info = await window.homecloud.setOrganizeByDate(e.target.checked);
    updateServerUI(info);
  });

  document.getElementById('toggleOrganizeByDevice').addEventListener('change', async (e) => {
    const info = await window.homecloud.setOrganizeByDevice(e.target.checked);
    updateServerUI(info);
  });

  // QR code tabs
  document.getElementById('tabNativeQr').addEventListener('click', () => {
    qrMode = 'native';
    document.getElementById('tabNativeQr').classList.add('active');
    document.getElementById('tabWebQr').classList.remove('active');
    if (serverInfo) document.getElementById('qrImage').src = serverInfo.qrDataUrl;
  });
  document.getElementById('tabWebQr').addEventListener('click', () => {
    qrMode = 'web';
    document.getElementById('tabWebQr').classList.add('active');
    document.getElementById('tabNativeQr').classList.remove('active');
    if (serverInfo) document.getElementById('qrImage').src = serverInfo.webQrDataUrl;
  });

  // Lightbox controls
  document.getElementById('lightboxCloseBtn').addEventListener('click', closeLightbox);
  document.getElementById('lightboxBackdrop').addEventListener('click', closeLightbox);
  document.getElementById('lightboxRevealBtn').addEventListener('click', () => {
    if (activeLightboxItem) {
      window.homecloud.revealMediaInFolder(activeLightboxItem.relativePath);
    }
  });
  document.getElementById('lightboxFavBtn').addEventListener('click', async () => {
    if (activeLightboxItem) {
      const updated = await window.homecloud.toggleFavorite(activeLightboxItem.id);
      if (updated) {
        activeLightboxItem.favorite = updated.favorite;
        document.getElementById('lightboxFavBtn').classList.toggle('fav-active', Boolean(updated.favorite));
        loadGallery();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // Real-time Server Events from Mobile Sync
  window.homecloud.onServerEvent((payload) => {
    const { type, data } = payload;
    if (type === 'media-uploaded') {
      if (data.info) updateServerUI(data.info);
      if (currentView === 'gallery') loadGallery();
    } else if (type === 'device-paired' || type === 'device-heartbeat') {
      if (data.info) updateServerUI(data.info);
    } else if (type === 'sync-progress') {
      updateLiveSyncBanner(data.activeSyncs || []);
    }
  });

  refreshAll();
});
