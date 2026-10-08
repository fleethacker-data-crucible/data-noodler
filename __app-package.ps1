# __app-package.ps1 - pack the whole app into ONE text file (__app.manifest), or rebuild it from that file.
# No git needed. Run via __app-package.cmd (menu), or:
#   powershell -ExecutionPolicy Bypass -File __app-package.ps1 [-Action Pack|Unpack] [-Root <folder>] [-Yes]
# Pack   : scans this folder, writes __app.manifest (folder list, file list, every file's contents).
# Unpack : rebuilds all folders and files from __app.manifest into this folder, then verifies them.
# Text files are stored verbatim (UTF-8, line endings and BOM kept). Binary files (fonts etc.) are Base64.
# Every file carries a SHA-256; pack and unpack both compare against it and report the match rate.
param(
    [ValidateSet('', 'Pack', 'Unpack')][string]$Action = '',
    [string]$Root = $PSScriptRoot,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$ManifestName = '__app.manifest'
$ManifestPath = Join-Path $Root $ManifestName

# ---------- what is NOT part of the app (data, caches, retired files, generated output) ----------
$SkipDirNames   = @('.git', 'node_modules')                            # not packed at all, at any depth
$EmptyDirNames  = @('.trash')                                          # folder kept, contents never packed (any depth)
$EmptyTopDirs   = @('projects')                                        # folder kept, contents never packed (relative to root)
$SkipTopDirs    = @('temp', 'test-data')                               # relative to root
$SkipPaths      = @('.server/logs', '.claude/worktrees')               # relative dirs
$SkipPathGlobs  = @('.server/.profile*')                               # relative dirs/files
$SkipFiles      = @('.server/.pid', '.claude/settings.local.json', $ManifestName)
$SkipFileGlobs  = @('js/duckdb/bench.*')
$SkipExt        = @('.md', '.csv', '.tsv', '.parquet', '.pq', '.sqlite', '.sqlite3', '.db', '.xlsx', '.xls', '.arrow', '.feather')

function Rel([string]$full) { $full.Substring($Root.Length + 1).Replace('\', '/') }

function Test-SkipDir([string]$rel, [string]$name) {
    if ($SkipDirNames -contains $name) { return $true }
    if ($SkipTopDirs -contains $rel) { return $true }
    if ($SkipPaths -contains $rel) { return $true }
    foreach ($g in $SkipPathGlobs) { if ($rel -like $g) { return $true } }
    return $false
}
function Test-SkipFile([string]$rel, [string]$ext) {
    if ($SkipFiles -contains $rel) { return $true }
    if ($SkipExt -contains $ext.ToLower()) { return $true }
    foreach ($g in $SkipFileGlobs) { if ($rel -like $g) { return $true } }
    foreach ($g in $SkipPathGlobs) { if ($rel -like $g) { return $true } }
    return $false
}

function Scan-Tree {
    $dirs = New-Object System.Collections.Generic.List[string]
    $files = New-Object System.Collections.Generic.List[string]
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $d = $stack.Pop()
        foreach ($e in (Get-ChildItem -LiteralPath $d -Force)) {
            $rel = Rel $e.FullName
            if ($e.PSIsContainer) {
                if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                if (Test-SkipDir $rel $e.Name) { continue }
                $dirs.Add($rel)
                if (($EmptyDirNames -contains $e.Name) -or ($EmptyTopDirs -contains $rel)) { continue }
                $stack.Push($e.FullName)
            } else {
                if (Test-SkipFile $rel $e.Extension) { continue }
                $files.Add($rel)
            }
        }
    }
    $dirs.Sort([StringComparer]::Ordinal); $files.Sort([StringComparer]::Ordinal)
    return @{ Dirs = $dirs; Files = $files }
}

$Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Sha = [Security.Cryptography.SHA256]::Create()
function Get-Hash([byte[]]$b) { -join ($Sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }

# returns line count for text bytes (LF-terminated lines, plus a final unterminated line)
function Count-Lines([byte[]]$b) {
    if ($b.Length -eq 0) { return 0 }
    $s = $Utf8.GetString($b)
    $n = $s.Length - $s.Replace("`n", '').Length
    if ($b[$b.Length - 1] -ne 10) { $n++ }
    return $n
}
function Test-Text([byte[]]$b) {
    if ([Array]::IndexOf($b, [byte]0) -ge 0) { return $false }
    try { [void]$Utf8Strict.GetString($b); return $true } catch { return $false }
}

# ---------- manifest reader (byte-exact, length-prefixed so file text can never collide with markers) ----------
function Read-Manifest([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $pos = 0
    $readLine = {
        if ($script:pos -ge $bytes.Length) { return $null }
        $i = [Array]::IndexOf($bytes, [byte]10, $script:pos)
        if ($i -lt 0) { $i = $bytes.Length }
        $line = $Utf8.GetString($bytes, $script:pos, $i - $script:pos)
        $script:pos = $i + 1
        return $line
    }
    $script:pos = 0
    $first = & $readLine
    if ($first -ne 'APP-MANIFEST v1') { throw "$path is not an APP-MANIFEST v1 file." }
    $m = @{ Dirs = @(); Entries = New-Object System.Collections.Generic.List[object]; Created = ''; Complete = $false }
    while ($true) {
        $line = & $readLine
        if ($null -eq $line) { break }
        if ($line.StartsWith('CREATED ')) { $m.Created = $line.Substring(8) }
        elseif ($line.StartsWith('D ')) { $m.Dirs += $line.Substring(2) }
        elseif ($line -eq '--- CONTENT ---') { break }
    }
    while ($true) {
        $line = & $readLine
        if ($null -eq $line) { break }
        if ($line -eq '=== END MANIFEST') { $m.Complete = $true; break }
        if (-not $line.StartsWith('=== FILE ')) { throw "Corrupt manifest near byte $($script:pos): '$line'" }
        $p = $line.Substring(9) -split " ", 6          # kind stored orig sha lines path
        $stored = [int]$p[1]
        $body = New-Object byte[] $stored
        [Array]::Copy($bytes, $script:pos, $body, 0, $stored)
        $script:pos += $stored + 1                      # body + separator LF
        if ($p[0] -eq 'binary') {
            $content = [Convert]::FromBase64String(($Utf8.GetString($body) -replace '\s', ''))
        } else { $content = $body }
        $m.Entries.Add(@{ Kind = $p[0]; Orig = [int]$p[2]; Sha = $p[3]; Lines = [int]$p[4]; Path = $p[5]; Content = $content })
    }
    return $m
}

function Show-Result([string]$title, [int]$match, [int]$total, $bad, [int]$dirs, [int]$files, [long]$lines, [long]$bytes) {
    $pct = if ($total -gt 0) { [math]::Round(100.0 * $match / $total, 2) } else { 100 }
    Write-Host ''
    Write-Host "== $title ==" -ForegroundColor Cyan
    Write-Host ("  Folders        : {0}" -f $dirs)
    Write-Host ("  Files          : {0}" -f $files)
    Write-Host ("  Lines of code  : {0:N0}" -f $lines)
    Write-Host ("  Total bytes    : {0:N0}" -f $bytes)
    $col = if ($match -eq $total) { 'Green' } else { 'Red' }
    Write-Host ("  Content match  : {0}/{1} files ({2}%)" -f $match, $total, $pct) -ForegroundColor $col
    foreach ($b in $bad) { Write-Host "    MISMATCH: $b" -ForegroundColor Red }
}

# ---------- PACK ----------
function Do-Pack {
    Write-Host "Scanning $Root ..."
    $scan = Scan-Tree
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($rel in $scan.Files) {
        $b = [IO.File]::ReadAllBytes((Join-Path $Root ($rel.Replace('/', '\'))))
        $text = Test-Text $b
        $entries.Add(@{ Path = $rel; Bytes = $b; Text = $text; Sha = (Get-Hash $b); Lines = $(if ($text) { Count-Lines $b } else { 0 }) })
    }
    $totalLines = 0; $totalBytes = 0
    foreach ($e in $entries) { $totalLines += $e.Lines; $totalBytes += $e.Bytes.Length }

    $tmp = $ManifestPath + '.tmp'
    $fs = [IO.File]::Create($tmp)
    $w = { param([string]$s) $x = $Utf8.GetBytes($s); $fs.Write($x, 0, $x.Length) }
    try {
        & $w "APP-MANIFEST v1`n"
        & $w "CREATED $((Get-Date).ToString('s'))`n"
        & $w "ROOT $(Split-Path $Root -Leaf)`n"
        & $w "TOTALS folders=$($scan.Dirs.Count) files=$($entries.Count) lines=$totalLines bytes=$totalBytes`n"
        & $w "--- STRUCTURE (what is in each folder; for reading only) ---`n"
        $byDir = @{}
        foreach ($e in $entries) {
            $k = if ($e.Path.Contains('/')) { $e.Path.Substring(0, $e.Path.LastIndexOf('/')) } else { '' }
            if (-not $byDir.ContainsKey($k)) { $byDir[$k] = @() }
            $byDir[$k] += $e
        }
        foreach ($d in (@('') + $scan.Dirs)) {
            $pad = '  ' * $(if ($d -eq '') { 0 } else { $d.Split('/').Count })
            $kids = if ($byDir.ContainsKey($d)) { @($byDir[$d]) } else { @() }
            $name = if ($d -eq '') { './' } else { $d.Substring($d.LastIndexOf('/') + 1) + '/' }
            & $w ("{0}{1}  ({2} files)`n" -f $pad, $name, $kids.Count)
            foreach ($f in $kids) { & $w ("{0}  - {1}  [{2}, {3} bytes, {4} lines]`n" -f $pad, $f.Path.Substring($f.Path.LastIndexOf('/') + 1), $(if ($f.Text) { 'text' } else { 'binary' }), $f.Bytes.Length, $f.Lines) }
        }
        & $w "--- TREE (machine list used by unpack: D folder / F kind bytes lines path) ---`n"
        foreach ($d in $scan.Dirs) { & $w "D $d`n" }
        foreach ($e in $entries) { & $w ("F {0} {1} {2} {3}`n" -f $(if ($e.Text) { 'text' } else { 'binary' }), $e.Bytes.Length, $e.Lines, $e.Path) }
        & $w "--- CONTENT ---`n"
        foreach ($e in $entries) {
            if ($e.Text) { $body = $e.Bytes; $kind = 'text' }
            else {
                $b64 = [Convert]::ToBase64String($e.Bytes)
                $sb = New-Object Text.StringBuilder
                for ($i = 0; $i -lt $b64.Length; $i += 100) { [void]$sb.Append($b64.Substring($i, [Math]::Min(100, $b64.Length - $i))).Append("`n") }
                $body = $Utf8.GetBytes($sb.ToString().TrimEnd("`n")); $kind = 'binary'
            }
            & $w ("=== FILE {0} {1} {2} {3} {4} {5}`n" -f $kind, $body.Length, $e.Bytes.Length, $e.Sha, $e.Lines, $e.Path)
            $fs.Write($body, 0, $body.Length)
            & $w "`n"
        }
        & $w "=== END MANIFEST`n"
    } finally { $fs.Close() }
    Move-Item -LiteralPath $tmp -Destination $ManifestPath -Force

    # verify: read the manifest back and compare every entry with the file on disk
    Write-Host 'Verifying manifest against files ...'
    $m = Read-Manifest $ManifestPath
    $match = 0; $bad = @()
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash $e.Content) -eq $e.Sha) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $e.Sha)) { $match++ } else { $bad += $e.Path }
    }
    if (-not $m.Complete) { $bad += '(manifest truncated)' }
    $mb = [math]::Round((Get-Item $ManifestPath).Length / 1MB, 2)
    Write-Host "Wrote $ManifestName ($mb MB)"
    Show-Result 'PACK' $match $entries.Count $bad $scan.Dirs.Count $entries.Count $totalLines $totalBytes
}

# ---------- UNPACK ----------
function Do-Unpack {
    if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Host "Missing $ManifestName in $Root" -ForegroundColor Red; return }
    Write-Host "Reading $ManifestName ..."
    $m = Read-Manifest $ManifestPath
    if (-not $m.Complete) { Write-Host 'Manifest is incomplete (truncated download?). Aborting.' -ForegroundColor Red; return }

    $differ = @()
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -ne $e.Sha)) { $differ += $e.Path }
    }
    if ($differ.Count -gt 0 -and -not $Yes) {
        Write-Host "$($differ.Count) existing file(s) differ from the manifest and will be overwritten, e.g.:" -ForegroundColor Yellow
        $differ | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
        if ((Read-Host 'Overwrite? (y/N)') -notmatch '^[yY]') { Write-Host 'Cancelled.'; return }
    }

    foreach ($d in $m.Dirs) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root ($d.Replace('/', '\')))) }
    $written = 0; $same = 0
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        if ($differ -notcontains $e.Path -and (Test-Path -LiteralPath $disk)) { $same++; continue }
        [void](New-Item -ItemType Directory -Force -Path (Split-Path $disk))
        [IO.File]::WriteAllBytes($disk, $e.Content); $written++
    }

    Write-Host 'Verifying rebuilt files against manifest ...'
    $match = 0; $bad = @(); $lines = 0; $bytes = 0
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        $lines += $e.Lines; $bytes += $e.Orig
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $e.Sha)) { $match++ } else { $bad += $e.Path }
    }
    Write-Host "Wrote $written file(s), $same already identical."
    Show-Result 'UNPACK' $match $m.Entries.Count $bad $m.Dirs.Count $m.Entries.Count $lines $bytes
}

# ---------- menu ----------
if ($Action -eq '') {
    Write-Host ''
    Write-Host '  APP PACKAGE  -  ' -NoNewline; Write-Host $Root -ForegroundColor DarkGray
    Write-Host '  1) Pack app into __app.manifest'
    Write-Host '  2) Unpack app from __app.manifest'
    Write-Host '  Q) Quit'
    switch -Regex (Read-Host 'Choose') { '^1' { $Action = 'Pack' } '^2' { $Action = 'Unpack' } default { return } }
}
if ($Action -eq 'Pack') { Do-Pack } else { Do-Unpack }
