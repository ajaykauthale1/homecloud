@echo off
echo Stopping HomeCloud Background Server...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4820 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo Stopped.
