@echo off
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:4820/api/show-window' -Method Post -TimeoutSec 2 | Out-Null } catch { Start-Process -FilePath 'd:\workspaces\homecloud\desktop\node_modules\electron\dist\electron.exe' -ArgumentList 'd:\workspaces\homecloud\desktop' }"
