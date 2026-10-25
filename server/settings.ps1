# Data Noodler settings and shortcut helpers, dot-sourced by server.ps1 (Windows PowerShell 5.1 and pwsh).
#
# Settings are layered, and only the last layer is ever written:
#   1. built-in defaults (Get-NoodlerDefaultSettings)
#   2. server\settings.json        - tracked defaults that ship with the tool; never written at run time
#   3. server\settings.local.json  - this install's changes (gitignored); Save-NoodlerSettings writes only this file
# A missing or broken layer is skipped, so the tool always falls back to the defaults.

function Get-NoodlerDefaultSettings {
    @{ port = 47823; portMode = 'manual'; browser = 'edge'; theme = 'dark'; fileThreads = 16; engineWorkers = 64; engineFreeMb = 1024; engineSpill = $true }
}

# Copies the valid values from one JSON settings file onto $Settings. Returns $true when the file was read.
function Merge-NoodlerSettingsFile {
    param([hashtable]$Settings, [string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    try { $j = [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { return $false }
    if (-not $j) { return $false }
    if ($j.port) { $Settings.port = [int]$j.port }
    if ($j.portMode -in 'manual', 'random') { $Settings.portMode = [string]$j.portMode }
    if ($j.browser -in 'edge', 'chrome') { $Settings.browser = [string]$j.browser }
    if ($j.theme -in 'dark', 'light') { $Settings.theme = [string]$j.theme }
    if ($j.fileThreads) { $Settings.fileThreads = [Math]::Max(1, [Math]::Min(64, [int]$j.fileThreads)) }
    if ($j.engineWorkers) { $Settings.engineWorkers = [Math]::Max(1, [Math]::Min(64, [int]$j.engineWorkers)) }
    if ($j.engineFreeMb) { $Settings.engineFreeMb = [Math]::Max(256, [Math]::Min(1048576, [int]$j.engineFreeMb)) }
    if ($null -ne $j.engineSpill) { $Settings.engineSpill = [bool]$j.engineSpill }
    return $true
}

function Read-NoodlerSettings {
    param([string]$DefaultsFile, [string]$LocalFile)
    $s = Get-NoodlerDefaultSettings
    [void](Merge-NoodlerSettingsFile -Settings $s -Path $DefaultsFile)
    [void](Merge-NoodlerSettingsFile -Settings $s -Path $LocalFile)
    return $s
}

# Writes the whole settings table to the local (untracked) file only, atomically (temp file, then replace).
function Save-NoodlerSettings {
    param([hashtable]$Settings, [string]$LocalFile)
    $dir = Split-Path -Parent $LocalFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    $json = $Settings | ConvertTo-Json
    $tmp = $LocalFile + '.tmp'
    [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
    if (Test-Path -LiteralPath $LocalFile) { Remove-Item -LiteralPath $LocalFile -Force }
    Move-Item -LiteralPath $tmp -Destination $LocalFile
}

# True when $Root is a git checkout (.git folder, or the .git file of a worktree).
function Test-NoodlerGitCheckout {
    param([string]$Root)
    return [bool](Test-Path -LiteralPath (Join-Path $Root '.git'))
}

<#
  Points the "Data Noodler.lnk" icon at this folder's assets\client_favicon.ico.
  In a git checkout the shortcut is a tracked file, so it is never rewritten there (returns 'skipped-git').
  In an installed copy it is saved only when the icon really differs (returns 'updated' or 'unchanged');
  'missing' when the shortcut or icon is not there. -OpenShortcut is a test hook for the WScript.Shell COM call.
#>
function Update-NoodlerShortcutIcon {
    param(
        [string]$Root,
        [scriptblock]$OpenShortcut = { param($p) (New-Object -ComObject WScript.Shell).CreateShortcut($p) }
    )
    $lnkPath = Join-Path $Root 'Data Noodler.lnk'
    $ico = Join-Path $Root 'assets\client_favicon.ico'
    if (-not (Test-Path -LiteralPath $lnkPath) -or -not (Test-Path -LiteralPath $ico)) { return 'missing' }
    if (Test-NoodlerGitCheckout -Root $Root) { return 'skipped-git' }
    $lnk = & $OpenShortcut $lnkPath
    $want = "$ico,0"
    if ([string]::Equals([string]$lnk.IconLocation, $want, [StringComparison]::OrdinalIgnoreCase)) { return 'unchanged' }
    $lnk.IconLocation = $want
    $lnk.Save()
    return 'updated'
}
