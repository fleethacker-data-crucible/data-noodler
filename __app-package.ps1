# __app-package.ps1 - pack the whole app into ONE gzip file (Data_Noodler_YY_MMDD_HHMM.gz), or rebuild it from that file.
# No git needed. Run via __app-package.cmd (menu), or:
#   powershell -ExecutionPolicy Bypass -File __app-package.ps1 [-Action Pack|Unpack] [-Root <folder>] [-File <package.gz>] [-Yes]
# Pack   : scans this folder (skipping everything .gitignore ignores), writes Data_Noodler_YY_MMDD_HHMM.gz.
#          Inside: one text file (Data_Noodler_YY_MMDD_HHMM.txt) with the folder list, the file list and every file as Base64.
# Unpack : rebuilds all folders and files from a package (-File, else the newest Data_Noodler_*.gz next to this script),
#          byte for byte, then verifies them. On a new machine: put this script, __app-package.cmd and the .gz in a folder, run Unpack.
# Every file carries a SHA-256; pack and unpack both compare against it and report the match rate.
param(
    [ValidateSet('', 'Pack', 'Unpack')][string]$Action = '',
    [string]$Root = $PSScriptRoot,
    [string]$File = '',
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$Prefix = 'Data_Noodler_'

# ---------- .gitignore (the root one): last matching rule wins; ! re-includes; a trailing / = folders only ----------
$Rules = New-Object System.Collections.Generic.List[object]
function Add-Rule([string]$line) {
    $p = $line.TrimEnd()
    if ($p -eq '' -or $p.StartsWith('#')) { return }
    $neg = $false; if ($p.StartsWith('!')) { $neg = $true; $p = $p.Substring(1) }
    $dirOnly = $false; if ($p.EndsWith('/')) { $dirOnly = $true; $p = $p.TrimEnd('/') }
    $anchored = $p.Contains('/'); $p = $p.TrimStart('/')
    $rx = ''
    for ($i = 0; $i -lt $p.Length; $i++) {
        $c = $p[$i]
        if ($c -eq '*') {
            if ($i + 1 -lt $p.Length -and $p[$i + 1] -eq '*') { $rx += '.*'; $i++; if ($i + 1 -lt $p.Length -and $p[$i + 1] -eq '/') { $i++ } }
            else { $rx += '[^/]*' }
        } elseif ($c -eq '?') { $rx += '[^/]' }
        else { $rx += [Regex]::Escape([string]$c) }
    }
    $rx = if ($anchored) { "^$rx$" } else { "(^|/)$rx$" }
    $Rules.Add(@{ Rx = New-Object Regex($rx, 'IgnoreCase'); Neg = $neg; DirOnly = $dirOnly })
}
$gi = Join-Path $Root '.gitignore'
if (Test-Path -LiteralPath $gi) { foreach ($l in [IO.File]::ReadAllLines($gi)) { Add-Rule $l } }
function Test-Ignored([string]$rel, [bool]$isDir) {
    $ign = $false
    foreach ($r in $Rules) { if ($r.DirOnly -and -not $isDir) { continue }; if ($r.Rx.IsMatch($rel)) { $ign = -not $r.Neg } }
    return $ign
}

function Rel([string]$full) { $full.Substring($Root.Length + 1).Replace('\', '/') }

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
                if ($e.Name -eq '.git' -or (Test-Ignored $rel $true)) { continue }
                $dirs.Add($rel); $stack.Push($e.FullName)
            } else {
                if ($rel -like "$Prefix*.gz" -or $rel -eq "$($Prefix)Install.ps1" -or (Test-Ignored $rel $false)) { continue }   # never a package (or its installer) inside a package
                $files.Add($rel)
            }
        }
    }
    $dirs.Sort([StringComparer]::Ordinal); $files.Sort([StringComparer]::Ordinal)
    return @{ Dirs = $dirs; Files = $files }
}

$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Sha = [Security.Cryptography.SHA256]::Create()
function Get-Hash([byte[]]$b) { -join ($Sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }

# ---------- gzip with the inner file name in its header (so tools extract Data_Noodler_...txt) ----------
function Write-Gz([string]$path, [byte[]]$data, [string]$innerName) {
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionLevel]::Optimal)
    $gz.Write($data, 0, $data.Length); $gz.Close()
    $b = $ms.ToArray()
    $name = [Text.Encoding]::ASCII.GetBytes($innerName + [char]0)
    $out = New-Object byte[] ($b.Length + $name.Length)
    [Array]::Copy($b, 0, $out, 0, 10); $out[3] = $out[3] -bor 8           # FLG.FNAME
    [Array]::Copy($name, 0, $out, 10, $name.Length)
    [Array]::Copy($b, 10, $out, 10 + $name.Length, $b.Length - 10)
    [IO.File]::WriteAllBytes($path, $out)
}
function Read-Gz([string]$path) {
    $fs = [IO.File]::OpenRead($path)
    try {
        $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
        $ms = New-Object IO.MemoryStream; $gz.CopyTo($ms); return ,$ms.ToArray()
    } finally { $fs.Close() }
}

# ---------- package text: header, TREE (D folder / F bytes path), then each file: === FILE bytes sha path + Base64 lines ----------
function Read-Package([string]$path) {
    $lines = $Utf8.GetString((Read-Gz $path)).Split("`n")
    if ($lines[0] -ne 'APP-PACKAGE v2') { throw "$path is not an APP-PACKAGE v2 file." }
    $m = @{ Dirs = New-Object System.Collections.Generic.List[string]; Entries = New-Object System.Collections.Generic.List[object]; Created = ''; Complete = $false }
    $i = 1; $cur = $null; $sb = $null
    for (; $i -lt $lines.Length; $i++) {
        $l = $lines[$i]
        if ($l.StartsWith('CREATED ')) { $m.Created = $l.Substring(8) }
        elseif ($l.StartsWith('D ')) { $m.Dirs.Add($l.Substring(2)) }
        elseif ($l -eq '--- CONTENT ---') { $i++; break }
    }
    $flush = { if ($cur) { $cur.Content = [Convert]::FromBase64String($sb.ToString()); $m.Entries.Add($cur) } }
    for (; $i -lt $lines.Length; $i++) {
        $l = $lines[$i]
        if ($l -eq '=== END PACKAGE') { & $flush; $cur = $null; $m.Complete = $true; break }
        if ($l.StartsWith('=== FILE ')) {
            & $flush
            $p = $l.Substring(9) -split ' ', 3        # bytes sha path
            $cur = @{ Orig = [long]$p[0]; Sha = $p[1]; Path = $p[2] }; $sb = New-Object Text.StringBuilder
        } elseif ($cur) { [void]$sb.Append($l) }
    }
    return $m
}

function Show-Result([string]$title, [int]$match, [int]$total, $bad, [int]$dirs, [int]$files, [long]$bytes) {
    $pct = if ($total -gt 0) { [math]::Round(100.0 * $match / $total, 2) } else { 100 }
    Write-Host ''
    Write-Host "== $title ==" -ForegroundColor Cyan
    Write-Host ("  Folders        : {0}" -f $dirs)
    Write-Host ("  Files          : {0}" -f $files)
    Write-Host ("  Total bytes    : {0:N0}" -f $bytes)
    $col = if ($match -eq $total) { 'Green' } else { 'Red' }
    Write-Host ("  Content match  : {0}/{1} files ({2}%)" -f $match, $total, $pct) -ForegroundColor $col
    foreach ($b in $bad) { Write-Host "    MISMATCH: $b" -ForegroundColor Red }
}

# ---------- PACK ----------
function Do-Pack {
    Write-Host "Scanning $Root (skipping what .gitignore ignores) ..."
    $scan = Scan-Tree
    $stamp = (Get-Date).ToString('yy_MMdd_HHmm')
    $name = "$Prefix$stamp"
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append("APP-PACKAGE v2`nCREATED $((Get-Date).ToString('s'))`nROOT $(Split-Path $Root -Leaf)`n")
    $entries = New-Object System.Collections.Generic.List[object]; $total = 0
    foreach ($rel in $scan.Files) {
        $b = [IO.File]::ReadAllBytes((Join-Path $Root ($rel.Replace('/', '\'))))
        $entries.Add(@{ Path = $rel; Bytes = $b; Sha = (Get-Hash $b) }); $total += $b.Length
    }
    [void]$sb.Append("TOTALS folders=$($scan.Dirs.Count) files=$($entries.Count) bytes=$total`n--- TREE ---`n")
    foreach ($d in $scan.Dirs) { [void]$sb.Append("D $d`n") }
    foreach ($e in $entries) { [void]$sb.Append("F $($e.Bytes.Length) $($e.Path)`n") }
    [void]$sb.Append("--- CONTENT ---`n")
    foreach ($e in $entries) {
        [void]$sb.Append("=== FILE $($e.Bytes.Length) $($e.Sha) $($e.Path)`n")
        $b64 = [Convert]::ToBase64String($e.Bytes)
        for ($i = 0; $i -lt $b64.Length; $i += 100) { [void]$sb.Append($b64, $i, [Math]::Min(100, $b64.Length - $i)).Append("`n") }
    }
    [void]$sb.Append("=== END PACKAGE`n")
    $out = Join-Path $Root "$name.gz"
    Write-Gz $out ($Utf8.GetBytes($sb.ToString())) "$name.txt"

    Write-Host 'Verifying package against files ...'
    $m = Read-Package $out
    $match = 0; $bad = @()
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash $e.Content) -eq $e.Sha) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $e.Sha)) { $match++ } else { $bad += $e.Path }
    }
    if (-not $m.Complete) { $bad += '(package truncated)' }
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 2)
    Write-Host "Wrote $name.gz ($mb MB)"
    Show-Result 'PACK' $match $entries.Count $bad $scan.Dirs.Count $entries.Count $total
}

# ---------- UNPACK ----------
function Do-Unpack {
    $pkg = $File
    if (-not $pkg) { $pkg = Get-ChildItem -LiteralPath $Root -Filter "$Prefix*.gz" | Sort-Object Name | Select-Object -Last 1 | ForEach-Object { $_.FullName } }
    if (-not $pkg -or -not (Test-Path -LiteralPath $pkg)) { Write-Host "No $Prefix*.gz package found in $Root" -ForegroundColor Red; return }
    Write-Host "Reading $(Split-Path $pkg -Leaf) ..."
    $m = Read-Package $pkg
    if (-not $m.Complete) { Write-Host 'Package is incomplete (truncated download?). Aborting.' -ForegroundColor Red; return }

    $differ = @()
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -ne $e.Sha)) { $differ += $e.Path }
    }
    if ($differ.Count -gt 0 -and -not $Yes) {
        Write-Host "$($differ.Count) existing file(s) differ from the package and will be overwritten, e.g.:" -ForegroundColor Yellow
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

    Write-Host 'Verifying rebuilt files against package ...'
    $match = 0; $bad = @(); $bytes = 0
    foreach ($e in $m.Entries) {
        $disk = Join-Path $Root ($e.Path.Replace('/', '\'))
        $bytes += $e.Orig
        if ((Test-Path -LiteralPath $disk) -and ((Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $e.Sha)) { $match++ } else { $bad += $e.Path }
    }
    Write-Host "Wrote $written file(s), $same already identical."
    Show-Result 'UNPACK' $match $m.Entries.Count $bad $m.Dirs.Count $m.Entries.Count $bytes
}

# ---------- menu ----------
if ($Action -eq '') {
    Write-Host ''
    Write-Host '  APP PACKAGE  -  ' -NoNewline; Write-Host $Root -ForegroundColor DarkGray
    Write-Host "  1) Pack app into $($Prefix)YY_MMDD_HHMM.gz"
    Write-Host "  2) Unpack app from the newest $($Prefix)*.gz"
    Write-Host '  Q) Quit'
    switch -Regex (Read-Host 'Choose') { '^1' { $Action = 'Pack' } '^2' { $Action = 'Unpack' } default { return } }
}
if ($Action -eq 'Pack') { Do-Pack } else { Do-Unpack }
