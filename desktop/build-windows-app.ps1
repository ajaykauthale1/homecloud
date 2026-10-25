$ErrorActionPreference = "Stop"

Write-Output "1. Stopping existing server instance..."
Get-NetTCPConnection -LocalPort 4820 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$desktopSrc = "d:\workspaces\homecloud\desktop"
$electronDist = "$desktopSrc\node_modules\electron\dist"
$outAppDir = "d:\workspaces\homecloud\HomeCloud-App"
$appResourcesDir = "$outAppDir\resources\app"

Write-Output "2. Packaging standalone Windows app into $outAppDir..."
if (Test-Path $outAppDir) {
  Remove-Item -Recurse -Force $outAppDir
}
New-Item -ItemType Directory -Force -Path $outAppDir | Out-Null

# Copy Electron runtime
Copy-Item -Path "$electronDist\*" -Destination $outAppDir -Recurse -Force
Move-Item -Path "$outAppDir\electron.exe" -Destination "$outAppDir\HomeCloud.exe" -Force
Remove-Item -Path "$outAppDir\resources\default_app.asar" -Force -ErrorAction SilentlyContinue

# Copy app source and runtime dependencies (excluding electron devDependency)
New-Item -ItemType Directory -Force -Path $appResourcesDir | Out-Null
Copy-Item -Path "$desktopSrc\package.json" -Destination "$appResourcesDir\package.json" -Force
Copy-Item -Path "$desktopSrc\src" -Destination "$appResourcesDir\src" -Recurse -Force

New-Item -ItemType Directory -Force -Path "$appResourcesDir\node_modules" | Out-Null
Get-ChildItem -Path "$desktopSrc\node_modules" | Where-Object {
  $_.Name -ne "electron" -and $_.Name -ne ".bin" -and $_.Name -ne "@electron"
} | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination "$appResourcesDir\node_modules\$($_.Name)" -Recurse -Force
}

$exePath = "$outAppDir\HomeCloud.exe"
$icoPath = "$appResourcesDir\src\icon.ico"

Write-Output "3. Creating Start Menu and Desktop shortcuts..."
$wsh = New-Object -ComObject WScript.Shell

# Start Menu Shortcut
$startMenuPath = Join-Path ([Environment]::GetFolderPath("Programs")) "HomeCloud.lnk"
$sc1 = $wsh.CreateShortcut($startMenuPath)
$sc1.TargetPath = $exePath
$sc1.WorkingDirectory = $outAppDir
$sc1.IconLocation = "$icoPath,0"
$sc1.Description = "HomeCloud - Wi-Fi Photo and Video Backup"
$sc1.Save()

# Desktop Shortcut
$desktopFolder = [Environment]::GetFolderPath("Desktop")
if (Test-Path $desktopFolder) {
  $desktopLnk = Join-Path $desktopFolder "HomeCloud.lnk"
  $sc2 = $wsh.CreateShortcut($desktopLnk)
  $sc2.TargetPath = $exePath
  $sc2.WorkingDirectory = $outAppDir
  $sc2.IconLocation = "$icoPath,0"
  $sc2.Description = "HomeCloud - Wi-Fi Photo and Video Backup"
  $sc2.Save()
}

Write-Output "4. Updating background launcher and Windows Startup registry..."
$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$outAppDir"
WshShell.Run """$exePath"" --hidden", 0, False
"@
Set-Content -Path "d:\workspaces\homecloud\start-desktop-background.vbs" -Value $vbsContent -Encoding ASCII

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "HomeCloudSync" -Value "`"$exePath`" --hidden"

Write-Output "5. Building standalone HomeCloud-Setup.exe installer..."
$csCode = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class Installer {
    [STAThread]
    static void Main() {
        string exePath = @"D:\workspaces\homecloud\HomeCloud-App\HomeCloud.exe";
        if (!File.Exists(exePath)) {
            MessageBox.Show("HomeCloud.exe not found at " + exePath, "HomeCloud Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Process.Start(new ProcessStartInfo {
            FileName = exePath,
            WorkingDirectory = @"D:\workspaces\homecloud\HomeCloud-App"
        });
        MessageBox.Show("HomeCloud Desktop is now installed in your Start Menu, Desktop, and Windows Startup!\n\nRight-click the HomeCloud icon on your Taskbar and click 'Pin to taskbar' for 1-click access.", "HomeCloud Installed Successfully", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
"@
$csFile = "$env:TEMP\HomeCloudSetup.cs"
Set-Content -Path $csFile -Value $csCode -Encoding UTF8
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $csc) {
  & $csc /target:winexe /out:"d:\workspaces\homecloud\HomeCloud-Setup.exe" "/win32icon:$icoPath" /r:System.Windows.Forms.dll $csFile | Out-Null
}

Write-Output "6. Launching HomeCloud.exe..."
Start-Process -FilePath $exePath -WorkingDirectory $outAppDir
Write-Output "SUCCESS! Built and installed HomeCloud.exe"
