# Data_Noodler_Install.ps1 - installs Data Noodler from the Data_Noodler_YY_MMDD_HHMM.gz package next to it.
# Put this script, Data_Noodler_Install.bat and the .gz anywhere (e.g. the Desktop), then double-click the .bat (it runs
#   powershell -ExecutionPolicy Bypass -File Data_Noodler_Install.ps1, so the script-security block does not stop it).
# Installs into <user home>\Data_Noodler (every folder and file byte for byte, each checked against its SHA-256),
# puts a "Data Noodler" shortcut on the Desktop, then removes this script, the .bat and the .gz.
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Join-Path $env:USERPROFILE 'Data_Noodler'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Sha = [Security.Cryptography.SHA256]::Create()
function Get-Hash([byte[]]$b) { -join ($Sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function Bar([double]$f, [string]$label) {
    $w = 40; $n = [int][Math]::Floor($f * $w)
    Write-Host ("`r  [{0}{1}] {2,3}%  {3,-28}" -f ('#' * $n), ('.' * ($w - $n)), [int]($f * 100), $label) -NoNewline
}
function Done([string]$msg, [string]$color, [bool]$clean) {
    Write-Host ''; Write-Host "  $msg" -ForegroundColor $color; Write-Host ''
    [void](Read-Host '  Press Enter to exit')
    if ($clean) {
        if ($script:pkg) { Remove-Item -LiteralPath $script:pkg -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
    }
    exit
}

$script:pkg = Get-ChildItem -LiteralPath $Here -Filter 'Data_Noodler_*.gz' | Sort-Object Name | Select-Object -Last 1 | ForEach-Object { $_.FullName }
$ver = if ($script:pkg) { [IO.Path]::GetFileNameWithoutExtension($script:pkg).Substring(13) } else { '?' }

Clear-Host
# DN logo (4 rows) with DATA NOODLER (2 rows) and the version (YY_MMDD_HHMM) under it
$logo = @('+----------+', '| |~\ |\ | |', '| |_/ | \| |', '+----------+')
$text = @("|~\  /\  ~|~  /\    |\ |  /~\  /~\  |~\  |    |~~  |~)", "|_/ /~~\  |  /~~\   | \|  \_/  \_/  |_/  |__  |__  |~\", "v.$ver", '')
Write-Host ''
for ($k = 0; $k -lt 4; $k++) {
    Write-Host "  $($logo[$k])" -ForegroundColor Blue -NoNewline
    Write-Host "   $($text[$k])" -ForegroundColor $(if ($k -lt 2) { 'Cyan' } else { 'DarkGray' })
}
Write-Host ''
# Version tracker: the installed version is in <install>ersion.txt (written after every good install).
# Versions are YY_MMDD_HHMM, so comparing them as text compares them in time.
$verFile = Join-Path $Root 'version.txt'
$have = if (Test-Path -LiteralPath $verFile) { ([IO.File]::ReadAllText($verFile)).Trim() } else { '' }
Write-Host ("  Installed version : {0}" -f $(if ($have) { "v.$have" } else { 'N/A' }))
Write-Host ("  Package version   : v.{0}" -f $ver)
Write-Host "  Install folder    : $Root" -ForegroundColor DarkGray
Write-Host ''
if (-not $script:pkg) { Done 'No Data_Noodler_*.gz package found next to this script.' 'Red' $false }
$mode = 'Install'
if (-not $have) { [void](Read-Host '  Press Enter to install') }
elseif ($have -lt $ver) { $mode = 'Upgrade'; [void](Read-Host "  v.$have is installed. Press Enter to upgrade to v.$ver") }
elseif ($have -eq $ver) { $mode = 'Reinstall'; [void](Read-Host "  v.$ver is already installed. Press Enter to reinstall it") }
else {
    $mode = 'Downgrade'
    Write-Host "  A NEWER version (v.$have) is installed than this package (v.$ver)." -ForegroundColor Yellow
    if ((Read-Host '  Type Y to downgrade, or press Enter to cancel') -notmatch '^[yY]') { Done 'Cancelled. Nothing was changed.' 'DarkGray' $false }
}
Write-Host ''

try {
    # read the package: gzip -> text (header, D folders, === FILE bytes sha path + Base64 lines, === END PACKAGE)
    Bar 0 'Reading package'
    $fs = [IO.File]::OpenRead($script:pkg)
    try { $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress); $ms = New-Object IO.MemoryStream; $gz.CopyTo($ms) } finally { $fs.Close() }
    $lines = $Utf8.GetString($ms.ToArray()).Split("`n")
    if ($lines[0] -ne 'APP-PACKAGE v2') { throw 'This is not a Data Noodler package.' }
    $dirs = New-Object System.Collections.Generic.List[string]; $files = New-Object System.Collections.Generic.List[object]
    $i = 1
    for (; $i -lt $lines.Length; $i++) { if ($lines[$i].StartsWith('D ')) { $dirs.Add($lines[$i].Substring(2)) } elseif ($lines[$i] -eq '--- CONTENT ---') { $i++; break } }
    $cur = $null; $sb = $null; $complete = $false
    for (; $i -lt $lines.Length; $i++) {
        $l = $lines[$i]
        if ($l -eq '=== END PACKAGE' -or $l.StartsWith('=== FILE ')) {
            if ($cur) { $cur.B64 = $sb.ToString(); $files.Add($cur) }
            if ($l -eq '=== END PACKAGE') { $complete = $true; break }
            $p = $l.Substring(9) -split ' ', 3
            $cur = @{ Size = [long]$p[0]; Sha = $p[1]; Path = $p[2] }; $sb = New-Object Text.StringBuilder
        } elseif ($cur) { [void]$sb.Append($l) }
    }
    if (-not $complete) { throw 'The package is incomplete (truncated download?).' }

    # install
    foreach ($d in $dirs) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root ($d.Replace('/', '\')))) }
    # User data is never overwritten: projects, settings, users, charts and temp. A file there is written only when it
    # does not exist yet (a fresh install gets the defaults); everything else is program files and is replaced.
    $UserData = @('workspace/*', 'temp/*', 'config/*', 'server/settings.json', 'version.txt')
    $isUser = { param($p) foreach ($u in $UserData) { if ($p -like $u) { return $true } }; return $false }
    # Older installs kept the server in .server: move its settings to server\ and remove the old folder.
    $old = Join-Path $Root '.server'
    if (Test-Path -LiteralPath $old) {
        $os = Join-Path $old 'settings.json'; $ns = Join-Path $Root 'server\settings.json'
        if ((Test-Path -LiteralPath $os) -and -not (Test-Path -LiteralPath $ns)) { [void](New-Item -ItemType Directory -Force -Path (Split-Path $ns)); Move-Item -LiteralPath $os -Destination $ns }
        Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Older installs kept the engine source in engine\ (now server\data-engine) and its DLL cache in temp\engine.
    foreach ($o in 'engine', 'temp\engine') { $p = Join-Path $Root $o; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } }
    $kept = New-Object 'System.Collections.Generic.HashSet[string]'
    $n = 0
    foreach ($f in $files) {
        $disk = Join-Path $Root ($f.Path.Replace('/', '\'))
        $n++; Bar (0.8 * $n / $files.Count) 'Installing files'
        if ((& $isUser $f.Path) -and (Test-Path -LiteralPath $disk)) { [void]$kept.Add($f.Path); continue }
        [void](New-Item -ItemType Directory -Force -Path (Split-Path $disk))
        [IO.File]::WriteAllBytes($disk, [Convert]::FromBase64String($f.B64))
    }

    # verify: every file on disk against the package's SHA-256
    $ok = 0; $bad = @(); $n = 0
    foreach ($f in $files) {
        $disk = Join-Path $Root ($f.Path.Replace('/', '\'))
        if ($kept.Contains($f.Path)) { $ok++ }   # the user's own copy, kept on purpose
        elseif ((Test-Path -LiteralPath $disk) -and (Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $f.Sha) { $ok++ } else { $bad += $f.Path }
        $n++; Bar (0.8 + 0.2 * $n / $files.Count) 'Verifying files'
    }
    Bar 1 'Complete'
    Write-Host ''; Write-Host ''
    $pct = [Math]::Round(100.0 * $ok / [Math]::Max(1, $files.Count), 2)
    Write-Host ("  Folders: {0}   Files: {1}   Verified: {2}/{1} ({3}%)" -f $dirs.Count, $files.Count, $ok, $pct)
    if ($kept.Count) { Write-Host ("  Kept your projects / settings / charts: {0} file(s) not overwritten" -f $kept.Count) -ForegroundColor DarkGray }
    if ($bad.Count) {
        foreach ($b in $bad | Select-Object -First 10) { Write-Host "    MISMATCH: $b" -ForegroundColor Red }
        Done 'Install finished with errors. The package and this script were kept.' 'Red' $false
    }
    # Desktop shortcut: runs the installed app's server; icon from its assets
    $desk = [Environment]::GetFolderPath('Desktop')
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'Data Noodler.lnk'))
    $lnk.TargetPath = 'C:\Windows\System32\conhost.exe'
    $lnk.Arguments = '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'server\server.ps1') + '"'
    $lnk.WorkingDirectory = Join-Path $Root 'server'
    $lnk.IconLocation = (Join-Path $Root 'assets\client_favicon.ico') + ',0'
    $lnk.WindowStyle = 7
    $lnk.Save()
    [IO.File]::WriteAllText($verFile, $ver)
    Write-Host "  Installed v.$ver to $Root; shortcut 'Data Noodler' added to the Desktop."
    $word = @{ Install = 'Install'; Upgrade = 'Upgrade'; Reinstall = 'Reinstall'; Downgrade = 'Downgrade' }[$mode]
    Done "100% - $word complete." 'Green' $true
} catch {
    Write-Host ''; Done "Install failed: $($_.Exception.Message)" 'Red' $false
}
