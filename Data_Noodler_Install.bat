@echo off
rem Data_Noodler_Install.bat - double-click to run Data_Noodler_Install.ps1 (next to it) without the PowerShell
rem script-security block. Keep it in the same folder as the installer and the .gz package.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Data_Noodler_Install.ps1"
rem the installer removes itself (and the .gz) after a good install: then remove this file too
if not exist "%~dp0Data_Noodler_Install.ps1" ((goto) 2>nul & del "%~f0")
