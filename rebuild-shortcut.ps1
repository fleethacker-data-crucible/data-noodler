# Rebuild "Data Noodler.lnk" (next to this script). Relative: Start in is empty, so it runs from the folder the
# shortcut is in and keeps working wherever the app folder is moved or unpacked. The icon path must be full: the server updates it on start.
$ErrorActionPreference = 'Stop'

$Path = Join-Path $PSScriptRoot 'Data Noodler.lnk'

if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Path)
$lnk.TargetPath       = 'C:\Windows\System32\conhost.exe'
$lnk.Arguments        = '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ".server\server.ps1"'
$lnk.WorkingDirectory = ''
$lnk.IconLocation     = (Join-Path $PSScriptRoot 'assets\client_favicon.ico') + ',0'   # the server re-points it on start if the folder moved
$lnk.WindowStyle      = 7
$lnk.Save()

Write-Host "Shortcut rebuilt: $Path"
