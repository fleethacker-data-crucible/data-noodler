@echo off
rem Rebuilds the project from data-noodler.bundle.txt (same folder). Add -Force to overwrite existing files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-project.ps1" %*
pause
