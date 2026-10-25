# Data Noodler launcher (Data_Noodler.bat). Windows PowerShell 5.1, standard user, no admin.
#   1. creates "Data Noodler.lnk" in this folder when it is missing, or repairs it when it differs (WScript.Shell);
#      the shortcut is made on this computer and never tracked in git (it records the computer name and SID)
#   2. starts server\server.ps1 the same way the shortcut does: conhost.exe --headless, no console window
# If Windows Script Host (COM) is unavailable, the shortcut is skipped and Data Noodler still starts.
#   Data_Noodler.bat              shortcut + start
#   Data_Noodler.bat -NoStart     shortcut only
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'server\settings.ps1')

$state = Sync-NoodlerShortcut -Root $root
if ($state -eq 'unavailable') { Write-Host 'Shortcut "Data Noodler.lnk" not made (Windows Script Host unavailable).' -ForegroundColor Yellow }
else { Write-Host "Shortcut ""Data Noodler.lnk"": $state" }
if ($NoStart) { exit 0 }

$spec = Get-NoodlerShortcutSpec -Root $root
if (Test-Path -LiteralPath $spec.TargetPath) {
    Start-Process -FilePath $spec.TargetPath -ArgumentList $spec.Arguments -WorkingDirectory $root -WindowStyle Minimized
} else {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -ArgumentList '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "server\server.ps1"' -WorkingDirectory $root -WindowStyle Hidden
}
Write-Host 'Data Noodler is starting.'
exit 0
