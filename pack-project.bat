@echo off
rem Packs the project into data-noodler.bundle.txt (one text file) for build-project.bat to rebuild.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\pack.ps1" %*
pause