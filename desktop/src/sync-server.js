const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const exifParser = require('exif-parser');

class HomeCloudServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 4820;
    this.udpPort = options.udpPort || 4821;
    const workspaceRoot = 'D:\\workspaces\\homecloud';
    this.configDir = options.configDir || path.join(workspaceRoot, '.homecloud-data');
    this.defaultStorageDir = 'D:\\Phone Backup\\Cloud';

    this.ensureDir(this.configDir);
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = this.loadConfig();

    this.ensureDir(this.config.storageDir);
    this.tempUploadDir = path.join(this.configDir, 'tmp_uploads');
    this.ensureDir(this.tempUploadDir);

    this.indexPath = path.join(this.config.storageDir, '.homecloud-index.json');
    this.mediaIndex = this.loadMediaIndex();

    this.app = null;
    this.httpServer = null;
    this.udpServer = null;
    this.activeSyncs = new Map(); // deviceId -> { deviceName, current, total, lastFile, startedAt }
  }

  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  loadConfig() {
    const defaultCfg = {
      serverId: 'hc-' + crypto.randomBytes(4).toString('hex'),
      serverName: os.hostname() || 'HomeCloud-PC',
      pairCode: String(Math.floor(100000 + Math.random() * 900000)),
      storageDir: this.defaultStorageDir,
      organizeByDate: true, // YYYY/MM
      organizeByDevice: false, // Optional: <DeviceName>/YYYY/MM
      protectFromPhoneDelete: true, // Keep backup safe when deleted on phone (default ON)
      requirePairCode: false, // Minimal setup: allow instant LAN pairing or QR code
      pairedDevices: {}
    };

    if (fs.existsSync(this.configPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return { ...defaultCfg, ...saved };
      } catch (e) {
        return defaultCfg;
      }
    }
    fs.writeFileSync(this.configPath, JSON.stringify(defaultCfg, null, 2));
    return defaultCfg;
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  loadMediaIndex() {
    const defaultIndex = {
      items: [], // Array of media metadata objects
      hashes: {}, // sha256 -> item.id
      assetKeys: {} // deviceId:assetId or filename:size -> item.id
    };

    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        // Verify files still exist on disk
        const validItems = (raw.items || []).filter((item) => {
          const fullPath = path.join(this.config.storageDir, item.relativePath);
          return fs.existsSync(fullPath);
        });
        const hashes = {};
        const assetKeys = {};
        for (const item of validItems) {
          if (item.sha256) hashes[item.sha256] = item.id;
          if (item.assetKey) assetKeys[item.assetKey] = item.id;
          if (item.fileSizeKey) assetKeys[item.fileSizeKey] = item.id;
        }
        return { items: validItems, hashes, assetKeys };
      } catch (e) {
        return defaultIndex;
      }
    }
    return defaultIndex;
  }

  saveMediaIndex() {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.mediaIndex, null, 2));
    } catch (err) {
      console.error('Failed to save media index:', err);
    }
  }

  /**
   * Scan existing files in storageDir if user already has photos there
   */
  scanStorageDirectory() {
    const existingPaths = new Set(this.mediaIndex.items.map((i) => i.relativePath.replace(/\\/g, '/')));
    const mediaExts = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.mp4', '.mov', '.mkv', '.avi']);

    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (!mediaExts.has(ext)) continue;
          const relPath = path.relative(this.config.storageDir, fullPath).replace(/\\/g, '/');
          if (!existingPaths.has(relPath)) {
            try {
              const stat = fs.statSync(fullPath);
              const isVideo = ['.mp4', '.mov', '.mkv', '.avi'].includes(ext);
              const capturedDate = stat.mtime || stat.birthtime || new Date();
              const d = new Date(capturedDate);
              const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              const id = 'm-' + crypto.randomBytes(6).toString('hex');
              const fileSizeKey = `${entry.name.toLowerCase()}:${stat.size}`;
              const item = {
                id,
                filename: entry.name,
                originalName: entry.name,
                relativePath: relPath,
                mediaType: isVideo ? 'video' : 'photo',
                size: stat.size,
                capturedAt: d.toISOString(),
                syncedAt: new Date().toISOString(),
                yearMonth,
                deviceId: 'local-disk',
                deviceName: 'Local Folder',
                fileSizeKey,
                favorite: false
              };
              this.mediaIndex.items.push(item);
              this.mediaIndex.assetKeys[fileSizeKey] = id;
            } catch (e) {
              // ignore unreadable file
            }
          }
        }
      }
    };

    walk(this.config.storageDir);
    this.mediaIndex.items.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
    this.saveMediaIndex();
  }

  getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const results = [];
    for (const [name, netList] of Object.entries(interfaces)) {
      if (!netList) continue;
      for (const net of netList) {
        if (net.family === 'IPv4' && !net.internal) {
          // Prioritize standard private LAN ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
          const isVirtual = /vethernet|wsl|docker|vmware|vbox|hyper-v/i.test(name);
          results.push({
            name,
            address: net.address,
            netmask: net.netmask,
            isVirtual,
            priority: net.address.startsWith('192.168.') ? 1 : net.address.startsWith('10.') ? 2 : 3
          });
        }
      }
    }
    results.sort((a, b) => {
      if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1;
      return a.priority - b.priority;
    });
    return results;
  }

  getPrimaryIP() {
    const ips = this.getLocalIPs();
    return ips.length > 0 ? ips[0].address : '127.0.0.1';
  }

  async getConnectionInfo() {
    const primaryIP = this.getPrimaryIP();
    const allIPs = this.getLocalIPs();
    const serverUrl = `http://${primaryIP}:${this.port}`;
    const mobileWebUrl = `${serverUrl}/mobile`;
    const universalPairUrl = `${mobileWebUrl}?pair=1&ip=${encodeURIComponent(primaryIP)}&port=${this.port}&code=${encodeURIComponent(this.config.pairCode)}&serverId=${encodeURIComponent(this.config.serverId)}`;

    let qrDataUrl = '';
    let webQrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(universalPairUrl, {
        margin: 1,
        width: 240,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      webQrDataUrl = await QRCode.toDataURL(universalPairUrl, {
        margin: 1,
        width: 240,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
    } catch (e) {
      console.error('QR generation error:', e);
    }

    return {
      serverId: this.config.serverId,
      serverName: this.config.serverName,
      primaryIP,
      allIPs,
      port: this.port,
      udpPort: this.udpPort,
      pairCode: this.config.pairCode,
      serverUrl,
      mobileWebUrl,
      storageDir: this.config.storageDir,
      organizeByDate: this.config.organizeByDate,
      organizeByDevice: Boolean(this.config.organizeByDevice),
      protectFromPhoneDelete: this.config.protectFromPhoneDelete !== false,
      qrDataUrl,
      webQrDataUrl,
      pairedDevices: Object.values(this.config.pairedDevices || {}),
      activeSyncs: Array.from(this.activeSyncs.values()),
      stats: this.getStats()
    };
  }

  getStats() {
    let totalBytes = 0;
    let photoCount = 0;
    let videoCount = 0;
    for (const item of this.mediaIndex.items) {
      totalBytes += item.size || 0;
      if (item.mediaType === 'video') videoCount++;
      else photoCount++;
    }
    return {
      totalCount: this.mediaIndex.items.length,
      photoCount,
      videoCount,
      totalBytes
    };
  }

  setStorageDirectory(newDir) {
    this.ensureDir(newDir);
    this.config.storageDir = newDir;
    this.saveConfig();
    this.indexPath = path.join(this.config.storageDir, '.homecloud-index.json');
    this.mediaIndex = this.loadMediaIndex();
    this.scanStorageDirectory();
    this.emit('config-updated', this.config);
    return this.config.storageDir;
  }

   extractDateFromExifOrTimestamp(filePath, providedTimestamp) {
    if (providedTimestamp) {
      const num = Number(providedTimestamp);
      const d = !isNaN(num) && num > 1000000000 ? new Date(num) : new Date(providedTimestamp);
      if (!isNaN(d.getTime()) && d.getFullYear() > 1990 && d.getFullYear() < 2100) {
        return d;
      }
    }
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(65536);
        fs.readSync(fd, buffer, 0, 65536, 0);
        fs.closeSync(fd);
        const parser = exifParser.create(buffer);
        const result = parser.parse();
        if (result && result.tags && result.tags.DateTimeOriginal) {
          const exifDate = new Date(result.tags.DateTimeOriginal * 1000);
          if (!isNaN(exifDate.getTime()) && exifDate.getFullYear() > 1990) {
            return exifDate;
          }
        }
      }
    } catch (e) {
      // fallback to now
    }
    return new Date();
  }

  computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  setupRoutes() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '25mb' }));

    // Serve synced media files directly for the desktop gallery & mobile preview
    app.use('/media', (req, res, next) => {
      express.static(this.config.storageDir)(req, res, next);
    });

    // Serve built-in mobile web companion & native Android APK download
    app.use('/mobile', express.static(path.join(__dirname, 'mobile-web')));
    app.get('/', (req, res) => {
      this.emit('show-window');
      res.redirect('/mobile');
    });
    app.post('/api/show-window', (req, res) => {
      this.emit('show-window');
      res.json({ ok: true });
    });
    app.get('/HomeCloud.apk', (req, res) => {
      const apkPath = path.join(__dirname, 'mobile-web', 'HomeCloud.apk');
      if (fs.existsSync(apkPath)) {
        res.download(apkPath, 'HomeCloud.apk');
      } else {
        res.status(404).send('APK not found');
      }
    });

    // 1. Discovery & Ping endpoint (used by Mobile Auto-Sync to detect Home Wi-Fi server)
    app.get('/api/discover', (req, res) => {
      res.json({
        service: 'homecloud',
        version: '1.0.0',
        serverId: this.config.serverId,
        serverName: this.config.serverName,
        ip: this.getPrimaryIP(),
        port: this.port,
        requirePairCode: this.config.requirePairCode,
        timestamp: Date.now()
      });
    });

    // 2. Pair / Register mobile device
    app.post('/api/pair', (req, res) => {
      const { deviceId, deviceName, platform, pairCode } = req.body || {};
      if (this.config.requirePairCode && pairCode !== this.config.pairCode) {
        return res.status(403).json({ error: 'Invalid pairing code' });
      }
      const id = deviceId || 'dev-' + crypto.randomBytes(4).toString('hex');
      const token = crypto.randomBytes(16).toString('hex');
      const deviceRecord = {
        deviceId: id,
        deviceName: deviceName || 'Android Phone',
        platform: platform || 'Android',
        pairedAt: this.config.pairedDevices[id]?.pairedAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastSyncCount: this.config.pairedDevices[id]?.lastSyncCount || 0,
        totalSynced: this.config.pairedDevices[id]?.totalSynced || 0,
        ip: req.ip?.replace('::ffff:', '') || 'LAN'
      };
      this.config.pairedDevices[id] = deviceRecord;
      this.saveConfig();
      this.emit('device-paired', deviceRecord);

      res.json({
        success: true,
        token,
        serverId: this.config.serverId,
        serverName: this.config.serverName,
        device: deviceRecord
      });
    });

    // 3. Heartbeat / Status from mobile
    app.post('/api/heartbeat', (req, res) => {
      const { deviceId, deviceName, platform } = req.body || {};
      if (deviceId) {
        const existing = this.config.pairedDevices[deviceId] || {
          deviceId,
          deviceName: deviceName || 'Android Phone',
          platform: platform || 'Android',
          pairedAt: new Date().toISOString(),
          totalSynced: 0
        };
        existing.lastSeenAt = new Date().toISOString();
        if (deviceName) existing.deviceName = deviceName;
        existing.ip = req.ip?.replace('::ffff:', '') || 'LAN';
        this.config.pairedDevices[deviceId] = existing;
        this.saveConfig();
        this.emit('device-heartbeat', existing);
      }
      res.json({
        online: true,
        serverId: this.config.serverId,
        serverName: this.config.serverName,
        stats: this.getStats()
      });
    });

    // 4. Incremental Sync Check: Mobile sends list of candidate photos, Server returns only unsynced ones
    app.post('/api/check-sync', (req, res) => {
      const { deviceId, assets } = req.body || {};
      if (!Array.isArray(assets)) {
        return res.status(400).json({ error: 'assets array required' });
      }

      if (deviceId && this.config.pairedDevices[deviceId]) {
        this.config.pairedDevices[deviceId].lastSeenAt = new Date().toISOString();
      }

      const unsyncedIds = [];
      const alreadySyncedIds = [];

      for (const asset of assets) {
        const assetKey = `${deviceId || 'default'}:${asset.id}`;
        const fileSizeKey = asset.filename && asset.size
          ? `${String(asset.filename).toLowerCase()}:${asset.size}`
          : null;

        const existsByAssetId = Boolean(this.mediaIndex.assetKeys[assetKey]);
        const existsByFileSize = fileSizeKey ? Boolean(this.mediaIndex.assetKeys[fileSizeKey]) : false;

        if (existsByAssetId || existsByFileSize) {
          alreadySyncedIds.push(asset.id);
        } else {
          unsyncedIds.push(asset.id);
        }
      }

      res.json({
        totalChecked: assets.length,
        unsyncedCount: unsyncedIds.length,
        alreadySyncedCount: alreadySyncedIds.length,
        unsyncedIds
      });
    });

    // 5. Sync session progress notification from mobile
    app.post('/api/sync-progress', (req, res) => {
      const { deviceId, deviceName, status, current, total, lastFile } = req.body || {};
      if (deviceId) {
        if (status === 'completed' || status === 'idle') {
          this.activeSyncs.delete(deviceId);
        } else {
          this.activeSyncs.set(deviceId, {
            deviceId,
            deviceName: deviceName || 'Android Phone',
            status: status || 'syncing',
            current: current || 0,
            total: total || 0,
            lastFile: lastFile || '',
            updatedAt: Date.now()
          });
        }
        this.emit('sync-progress', {
          activeSyncs: Array.from(this.activeSyncs.values())
        });
      }
      res.json({ ok: true });
    });

    // 6. Multipart Photo / Video Upload
    const upload = multer({
      dest: this.tempUploadDir,
      limits: { fileSize: 2 * 1024 * 1024 * 1024 } // Up to 2GB per video/photo
    });

    app.post('/api/upload', upload.single('file'), async (req, res) => {
      const tempFile = req.file;
      if (!tempFile) {
        return res.status(400).json({ error: 'No media file uploaded' });
      }

      try {
        const {
          assetId,
          deviceId = 'mobile-device',
          deviceName = 'Mobile Phone',
          capturedAt,
          mediaType,
          width,
          height,
          duration,
          originalName
        } = req.body || {};

        const cleanOriginalName = path.basename(originalName || tempFile.originalname || `IMG_${Date.now()}.jpg`);
        const sha256 = await this.computeFileSha256(tempFile.path);
        const assetKey = assetId ? `${deviceId}:${assetId}` : null;
        const fileSizeKey = `${cleanOriginalName.toLowerCase()}:${tempFile.size}`;

        // Deduplicate by SHA-256 hash
        if (this.mediaIndex.hashes[sha256]) {
          const existingId = this.mediaIndex.hashes[sha256];
          if (assetKey) this.mediaIndex.assetKeys[assetKey] = existingId;
          this.mediaIndex.assetKeys[fileSizeKey] = existingId;
          this.saveMediaIndex();
          fs.unlinkSync(tempFile.path);
          const existingItem = this.mediaIndex.items.find((i) => i.id === existingId);
          return res.json({
            success: true,
            duplicate: true,
            item: existingItem
          });
        }

        // Determine capture date for YYYY/MM folder structure (and optional <DeviceName> subfolder)
        const captureDate = this.extractDateFromExifOrTimestamp(tempFile.path, capturedAt);
        const year = String(captureDate.getFullYear());
        const month = String(captureDate.getMonth() + 1).padStart(2, '0');
        const yearMonth = `${year}-${month}`;

        const safeDeviceFolder = String(deviceName || 'Mobile').replace(/[<>:"/\\|?*]+/g, '_').trim();
        const baseTargetDir = this.config.organizeByDevice
          ? path.join(this.config.storageDir, safeDeviceFolder)
          : this.config.storageDir;

        const targetSubdir = this.config.organizeByDate
          ? path.join(baseTargetDir, year, month)
          : baseTargetDir;

        this.ensureDir(targetSubdir);

        // Avoid filename collision if different photo has same filename
        const ext = path.extname(cleanOriginalName) || '.jpg';
        const base = path.basename(cleanOriginalName, ext);
        let finalFilename = cleanOriginalName;
        let destPath = path.join(targetSubdir, finalFilename);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          finalFilename = `${base}_${counter}${ext}`;
          destPath = path.join(targetSubdir, finalFilename);
          counter++;
        }

        fs.copyFileSync(tempFile.path, destPath);
        fs.unlinkSync(tempFile.path);

        // Preserve original capture date on the file's mtime
        try {
          fs.utimesSync(destPath, captureDate, captureDate);
        } catch (e) {
          // ignore utimes errors
        }

        const isVideo =
          mediaType === 'video' ||
          ['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext.toLowerCase());

        const relativePath = path.relative(this.config.storageDir, destPath).replace(/\\/g, '/');
        const id = 'm-' + crypto.randomBytes(6).toString('hex');

        const newItem = {
          id,
          assetId: assetId || null,
          assetKey,
          fileSizeKey,
          sha256,
          filename: finalFilename,
          originalName: cleanOriginalName,
          relativePath,
          mediaType: isVideo ? 'video' : 'photo',
          size: tempFile.size,
          width: width ? Number(width) : null,
          height: height ? Number(height) : null,
          duration: duration ? Number(duration) : null,
          capturedAt: captureDate.toISOString(),
          syncedAt: new Date().toISOString(),
          yearMonth,
          deviceId,
          deviceName,
          favorite: false
        };

        this.mediaIndex.items.unshift(newItem);
        this.mediaIndex.items.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        this.mediaIndex.hashes[sha256] = id;
        if (assetKey) this.mediaIndex.assetKeys[assetKey] = id;
        this.mediaIndex.assetKeys[fileSizeKey] = id;
        this.saveMediaIndex();

        // Update device record
        const dev = this.config.pairedDevices[deviceId] || {
          deviceId,
          deviceName,
          platform: 'Android',
          pairedAt: new Date().toISOString(),
          totalSynced: 0
        };
        dev.lastSeenAt = new Date().toISOString();
        dev.deviceName = deviceName || dev.deviceName;
        dev.totalSynced = (dev.totalSynced || 0) + 1;
        this.config.pairedDevices[deviceId] = dev;
        this.saveConfig();

        this.emit('media-uploaded', newItem);

        res.json({
          success: true,
          duplicate: false,
          item: newItem
        });
      } catch (err) {
        console.error('Upload error:', err);
        if (tempFile && fs.existsSync(tempFile.path)) {
          try {
            fs.unlinkSync(tempFile.path);
          } catch (e) {}
        }
        res.status(500).json({ error: err.message || 'Upload failed' });
      }
    });

    // 7. Gallery listing for Desktop & Mobile UI
    app.get('/api/media', (req, res) => {
      const { filter = 'all', search = '', limit = 500 } = req.query;
      let list = this.mediaIndex.items;
      if (filter === 'photos') list = list.filter((i) => i.mediaType === 'photo');
      else if (filter === 'videos') list = list.filter((i) => i.mediaType === 'video');
      else if (filter === 'favorites') list = list.filter((i) => i.favorite);

      if (search) {
        const q = String(search).toLowerCase();
        list = list.filter(
          (i) =>
            i.filename.toLowerCase().includes(q) ||
            (i.yearMonth && i.yearMonth.includes(q)) ||
            (i.deviceName && i.deviceName.toLowerCase().includes(q))
        );
      }

      res.json({
        items: list.slice(0, Number(limit) || 500),
        stats: this.getStats()
      });
    });

    // 8. Toggle favorite on media item
    app.post('/api/media/:id/favorite', (req, res) => {
      const item = this.mediaIndex.items.find((i) => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      item.favorite = !item.favorite;
      this.saveMediaIndex();
      this.emit('media-updated', item);
      res.json({ item });
    });

    this.app = app;
  }

  startUdpDiscovery() {
    try {
      const udp = dgram.createSocket('udp4');
      udp.on('error', (err) => {
        console.warn('UDP discovery socket warning:', err.message);
      });
      udp.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8').trim();
        if (text.startsWith('HOMECLOUD_DISCOVER')) {
          const reply = JSON.stringify({
            service: 'homecloud',
            serverId: this.config.serverId,
            serverName: this.config.serverName,
            ip: this.getPrimaryIP(),
            port: this.port,
            pairCode: this.config.pairCode
          });
          udp.send(Buffer.from(reply), rinfo.port, rinfo.address);
        }
      });
      udp.bind(this.udpPort, '0.0.0.0', () => {
        try {
          udp.setBroadcast(true);
        } catch (e) {}
      });
      this.udpServer = udp;
    } catch (e) {
      console.warn('Could not bind UDP discovery:', e.message);
    }
  }

  async start() {
    this.scanStorageDirectory();
    this.setupRoutes();
    this.startUdpDiscovery();

    return new Promise((resolve, reject) => {
      this.httpServer = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`HomeCloud Server listening on http://${this.getPrimaryIP()}:${this.port}`);
        resolve(this.getConnectionInfo());
      });
      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.port += 1;
          this.httpServer.listen(this.port, '0.0.0.0');
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.udpServer) {
      this.udpServer.close();
      this.udpServer = null;
    }
  }
}

module.exports = { HomeCloudServer };
