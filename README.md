# HomeCloud — Automatic Wi-Fi Photo & Video Backup

Zero-touch local home cloud that automatically backs up photos and videos from your Android phone into **`D:\Phone Backup\Cloud\YYYY\MM`** whenever your phone and PC are on the same Wi-Fi network.

---

## Key Features

- **Zero-Touch Wi-Fi Auto-Sync**: No QR scanning or manual IP entry required. When your phone connects to your home Wi-Fi, it automatically discovers your PC (`192.168.1.159:4820` or scans the `/24` subnet if your router changes the IP) and uploads new photos and videos in the background.
- **One-Way Protected Vault (`D:\Phone Backup\Cloud\YYYY\MM`)**:
  - Automatically organizes photos & videos by capture date (`YYYY/MM`, e.g. `D:\Phone Backup\Cloud\2026\10\`).
  - **Keep Backup Safe When Deleted on Phone** (enabled by default): Deleting photos or videos from your phone to free up space will **never** automatically delete them from `D:\Phone Backup\Cloud` unless you explicitly turn off protection.
  - **SHA-256 & Asset-ID Deduplication**: Never uploads the same photo or video twice.
- **Runs Silently in the Background on Both Desktop & Mobile**:
  - **Desktop (Windows)**: Runs hidden in the Windows System Tray and auto-starts on Windows login.
  - **Android (`HomeCloud.apk`)**: Uses native Android `JobScheduler` (`NETWORK_TYPE_UNMETERED` + `MediaStore` content triggers) and `BootReceiver` to sync in the background even when the app is closed or after the phone reboots.

---

## 1. Desktop Server & Gallery (Windows PC)

### Desktop App & Taskbar Pinning (Already Installed)
- **Windows Executable**: [`D:\workspaces\homecloud\HomeCloud.exe`](HomeCloud.exe) (compiled with custom cloud icon and installed into your **Windows Start Menu**, **Desktop**, and **Windows Startup**).
- **Pin to Taskbar**: Right-click the open **HomeCloud** icon on your Windows Taskbar (or search **HomeCloud** in your Start Menu) and click **"Pin to taskbar"**. Clicking the Taskbar icon anytime immediately opens/focuses the Dashboard window.
- **Auto-Start on Windows Login**: Registered in `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\HomeCloudSync` to launch `HomeCloud.exe --hidden` silently on boot.
- **System Tray Icon**: Look for the blue **HomeCloud** cloud icon in the Windows System Tray (bottom-right near the clock):
  - **Click / Double-click** to open the **HomeCloud Gallery & Settings** window.
  - **Close (`✕`)** the window to hide it back to the system tray while keeping the Wi-Fi sync server active.

### Desktop Scripts
| Action | Script / Command |
| :--- | :--- |
| **Start in Background (Hidden Tray)** | Double-click [`start-desktop-background.vbs`](start-desktop-background.vbs) |
| **Stop Background Server** | Double-click [`stop-background.bat`](stop-background.bat) (or Right-click Tray Icon → *Quit HomeCloud*) |
| **Start Desktop GUI from Terminal** | `cd desktop && npm start` |
| **Change Backup Path (`D:\Phone Backup\Cloud`)** | Open Desktop App → **Storage & Folder** → Enter path & click **Save Path** |

---

## 2. Android Mobile App (`HomeCloud.apk`)

### Where to Get the APK
1. **Local File on PC**: [`D:\workspaces\homecloud\HomeCloud.apk`](HomeCloud.apk)
2. **Direct Wi-Fi Download on Phone**: While connected to the same Wi-Fi, open Chrome on your Android phone and visit:
   ```text
   http://192.168.1.159:4820/HomeCloud.apk
   ```
   *(Or open `http://192.168.1.159:4820/mobile` to use the browser companion or download the APK).*

### One-Time Phone Setup
1. Install **`HomeCloud.apk`** on your Android phone.
2. Open **HomeCloud Sync** once and tap **Allow** when prompted for Photo & Video permissions.
3. Keep **"Auto-Sync in Background on Same Wi-Fi"** and **"Keep PC Backup Safe If Deleted on Phone"** enabled (both are ON by default).

### Rebuilding the Native APK Locally (Optional)
If you ever modify the native Android source code in [`android-apk/src/com/homecloud/sync/`](android-apk/src/com/homecloud/sync/), rebuild and sign `HomeCloud.apk` in ~3 seconds with:
```powershell
powershell -ExecutionPolicy Bypass -File "d:\workspaces\homecloud\android-apk\build-apk.ps1"
```

---

## 3. Optional Expo / React Native Project (`mobile/`)

An Expo SDK 58 project is also included in [`mobile/`](mobile/) and linked to your Expo account (`@kauthalejay40s-team/kauthalejay`, Project ID `26f83b5c-570e-4be0-8ec2-cccc20e4b20d`):
```powershell
cd d:\workspaces\homecloud\mobile
npx expo start
# Or build on Expo Cloud:
npx eas-cli build -p android --profile preview
```
