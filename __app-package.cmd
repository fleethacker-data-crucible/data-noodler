@echo off
rem Menu: pack the app into __app.manifest, or unpack it from there. Extra args pass through (e.g. -Action Pack).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0__app-package.ps1" %*
pause
