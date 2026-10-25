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

<#
  The "Data Noodler.lnk" shortcut in the tool folder, as a plain object: Path, TargetPath, Arguments,
  WorkingDirectory, Description, IconLocation, WindowStyle. Same target, arguments, icon and window style as the
  shortcut that used to be tracked in git: conhost.exe --headless powershell.exe ... -File "server\server.ps1",
  relative, with an empty Start in (so the folder can move). Only Path and the icon come from $Root.
  The shortcut is not tracked (it records the computer name and the user's SID): each computer makes its own.
#>
function Get-NoodlerShortcutSpec {
    param([Parameter(Mandatory)][string]$Root, [string]$SystemRoot = $env:SystemRoot)
    if (-not $SystemRoot) { $SystemRoot = 'C:\Windows' }
    $ico = [IO.Path]::Combine($Root, 'assets', 'client_favicon.ico')
    [pscustomobject]@{
        Path             = [IO.Path]::Combine($Root, 'Data Noodler.lnk')
        TargetPath       = $SystemRoot.TrimEnd('\') + '\System32\conhost.exe'
        Arguments        = '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "server\server.ps1"'
        WorkingDirectory = ''
        Description      = ''
        IconLocation     = "$ico,0"
        WindowStyle      = 7
    }
}

# True when a WScript.Shell shortcut object already matches the spec (%VARS% expanded, case-insensitive).
function Test-NoodlerShortcutMatch {
    param([Parameter(Mandatory)]$Shortcut, [Parameter(Mandatory)]$Spec)
    foreach ($f in 'TargetPath', 'Arguments', 'WorkingDirectory', 'Description', 'IconLocation') {
        $a = [Environment]::ExpandEnvironmentVariables(('' + $Shortcut.$f)).Trim()
        $b = [Environment]::ExpandEnvironmentVariables(('' + $Spec.$f)).Trim()
        if (-not [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    return ([int]$Shortcut.WindowStyle -eq [int]$Spec.WindowStyle)
}

<#
  Creates "Data Noodler.lnk" in $Root when it is missing and repairs it when it differs from the spec (for example
  after the folder moved, so the icon path is stale). A matching shortcut is not written.
  Returns 'created', 'repaired', 'unchanged' or 'unavailable' (WScript.Shell / COM could not be used, or the save
  failed). Never throws, so it can never stop a launch. -OpenShortcut is a test hook for the WScript.Shell call.
#>
function Sync-NoodlerShortcut {
    param(
        [Parameter(Mandatory)][string]$Root,
        [scriptblock]$OpenShortcut = { param($p) (New-Object -ComObject WScript.Shell).CreateShortcut($p) }
    )
    try {
        $spec = Get-NoodlerShortcutSpec -Root $Root
        $existed = Test-Path -LiteralPath $spec.Path
        $lnk = & $OpenShortcut $spec.Path
        if (-not $lnk) { return 'unavailable' }
        if ($existed -and (Test-NoodlerShortcutMatch -Shortcut $lnk -Spec $spec)) { return 'unchanged' }
        $lnk.TargetPath = $spec.TargetPath
        $lnk.Arguments = $spec.Arguments
        $lnk.WorkingDirectory = $spec.WorkingDirectory
        $lnk.Description = $spec.Description
        $lnk.IconLocation = $spec.IconLocation
        $lnk.WindowStyle = $spec.WindowStyle
        $lnk.Save()
        if ($existed) { return 'repaired' }
        return 'created'
    } catch { return 'unavailable' }
}
