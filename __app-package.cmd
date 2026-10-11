@echo off
rem Menu: pack the app into Data_Noodler_YY_MMDD_HHMM.gz, or unpack it from there. Extra args pass through (e.g. -Action Pack).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0__app-package.ps1" %*
pause
