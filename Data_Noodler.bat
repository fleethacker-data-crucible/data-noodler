@echo off
rem Data_Noodler.bat - creates or repairs "Data Noodler.lnk" in this folder (first run), then starts Data Noodler
rem with no console window. No admin rights are needed. After the first run you can use the shortcut instead.
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0Start-DataNoodler.ps1" %*
