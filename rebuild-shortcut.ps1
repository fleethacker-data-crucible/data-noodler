# Rebuild "Data Noodler.lnk" (next to this script) with fixed settings.
$ErrorActionPreference = 'Stop'

$Path = Join-Path $PSScriptRoot 'Data Noodler.lnk'
$Root = $PSScriptRoot

if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Path)
$lnk.TargetPath       = 'C:\Windows\System32\conhost.exe'
$lnk.Arguments        = '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Root + '\.server\server.ps1"'
$lnk.WorkingDirectory = "$Root\.server"
$lnk.IconLocation     = "$Root\assets\client_favicon.ico,0"
$lnk.WindowStyle      = 7
$lnk.Save()

Write-Host "Shortcut rebuilt: $Path"
