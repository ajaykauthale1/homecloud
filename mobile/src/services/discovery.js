import * as Network from 'expo-network';

const DEFAULT_KNOWN_IPS = ['192.168.1.159'];

export async function pingServer(ip, port = 4820, timeoutMs = 850) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/api/discover`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.service === 'homecloud') {
      return {
        ...data,
        ip,
        port: data.port || port,
        url: `http://${ip}:${data.port || port}`
      };
    }
    return null;
  } catch (_err) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Automatically scans the phone's current Wi-Fi /24 subnet for a running HomeCloud Desktop server.
 * Checks known default desktop IPs first for instant (<50ms) connection.
 */
export async function discoverDesktopOnWifi(port = 4820, onProgress = null) {
  // Fast path: check known PC LAN IP first
  for (const knownIp of DEFAULT_KNOWN_IPS) {
    const fastHit = await pingServer(knownIp, port, 600);
    if (fastHit) {
      if (onProgress) onProgress(100);
      return fastHit;
    }
  }

  let phoneIp = null;
  try {
    phoneIp = await Network.getIpAddressAsync();
  } catch (_e) {
    return null;
  }

  if (!phoneIp || phoneIp === '0.0.0.0' || !phoneIp.includes('.')) {
    return null;
  }

  const parts = phoneIp.split('.');
  if (parts.length !== 4) return null;
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const selfHost = Number(parts[3]);

  const candidates = [];
  for (let i = 1; i <= 254; i++) {
    if (i !== selfHost) candidates.push(`${prefix}.${i}`);
  }

  const batchSize = 36;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    if (onProgress) {
      onProgress(Math.min(100, Math.round(((i + batch.length) / candidates.length) * 100)));
    }
    const results = await Promise.all(batch.map((ip) => pingServer(ip, port, 700)));
    const found = results.find((r) => r !== null);
    if (found) {
      if (onProgress) onProgress(100);
      return found;
    }
  }

  return null;
}
