$ErrorActionPreference = "Stop"

# 1. Generate standard Windows .ico via System.Drawing.Icon for csc.exe compatibility
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$rect = New-Object System.Drawing.Rectangle(2, 2, 60, 60)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 14, 165, 233),
  [System.Drawing.Color]::FromArgb(255, 79, 70, 229),
  45.0
)
$g.FillEllipse($brush, 2, 2, 60, 60)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($white, 12, 26, 18, 18)
$g.FillEllipse($white, 22, 18, 22, 22)
$g.FillEllipse($white, 36, 28, 16, 16)
$g.FillRectangle($white, 20, 32, 24, 12)

$icoPath = "d:\workspaces\homecloud\desktop\src\app.ico"
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()
$g.Dispose()
$bmp.Dispose()

# 2. Write C# source for native HomeCloud.exe Windows Application
$csPath = "d:\workspaces\homecloud\desktop\HomeCloudLauncher.cs"
$csSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;

class HomeCloudApp {
    [STAThread]
    static void Main(string[] args) {
        bool hidden = false;
        foreach (string a in args) {
            if (a == "--hidden") hidden = true;
        }

        // If already running in background, pop up the Dashboard window immediately
        if (!hidden) {
            try {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4820/api/show-window");
                req.Method = "POST";
                req.Timeout = 700;
                req.ContentLength = 0;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) {
                    if (resp.StatusCode == HttpStatusCode.OK) {
                        return;
                    }
                }
            } catch {
                // Server not running yet; start it below
            }
        }

        string electronExe = @"D:\workspaces\homecloud\desktop\node_modules\electron\dist\electron.exe";
        string appDir = @"D:\workspaces\homecloud\desktop";
        string arguments = "\"" + appDir + "\"" + (hidden ? " --hidden" : "");

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = electronExe;
        psi.Arguments = arguments;
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
    }
}
'@
Set-Content -Path $csPath -Value $csSource -Encoding ASCII

# 3. Compile HomeCloud.exe with custom icon
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$outExe = "d:\workspaces\homecloud\HomeCloud.exe"
& $csc /nologo /target:winexe "/out:$outExe" "/win32icon:$icoPath" $csPath
Remove-Item $csPath -Force -ErrorAction SilentlyContinue

# Clean up temporary HomeCloud-App copy
if (Test-Path "d:\workspaces\homecloud\HomeCloud-App") {
  Remove-Item -Recurse -Force "d:\workspaces\homecloud\HomeCloud-App" -ErrorAction SilentlyContinue
}

# 4. Create Start Menu and Desktop Shortcuts pointing to HomeCloud.exe
$wsh = New-Object -ComObject WScript.Shell
$startMenuLnk = Join-Path ([Environment]::GetFolderPath("Programs")) "HomeCloud.lnk"
$sc1 = $wsh.CreateShortcut($startMenuLnk)
$sc1.TargetPath = $outExe
$sc1.WorkingDirectory = "d:\workspaces\homecloud"
$sc1.IconLocation = "$outExe,0"
$sc1.Description = "HomeCloud Desktop Dashboard"
$sc1.Save()

$desktopDir = [Environment]::GetFolderPath("Desktop")
if (Test-Path $desktopDir) {
  $desktopLnk = Join-Path $desktopDir "HomeCloud.lnk"
  $sc2 = $wsh.CreateShortcut($desktopLnk)
  $sc2.TargetPath = $outExe
  $sc2.WorkingDirectory = "d:\workspaces\homecloud"
  $sc2.IconLocation = "$outExe,0"
  $sc2.Description = "HomeCloud Desktop Dashboard"
  $sc2.Save()
}

# 5. Update Windows Startup Registry to use HomeCloud.exe --hidden
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "HomeCloudSync" -Value "`"$outExe`" --hidden"

Write-Output "Compiled and installed: $outExe"
