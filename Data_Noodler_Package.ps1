# Data_Noodler_Package.ps1 - packages the app folder (the folder this script is in) into Data_Noodler_YY_MMDD_HHMM.gz
# next to it: one text file inside (Data_Noodler_YY_MMDD_HHMM.txt) with the folder list and every file as Base64.
# Skips everything .gitignore ignores (and old packages and the installer). Install with Data_Noodler_Install.ps1.
# Right-click > Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File Data_Noodler_Package.ps1).
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot.TrimEnd('\')
$Prefix = 'Data_Noodler_'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Sha = [Security.Cryptography.SHA256]::Create()
function Get-Hash([byte[]]$b) { -join ($Sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function Bar([double]$f, [string]$label) {
    $w = 40; $n = [int][Math]::Floor($f * $w)
    Write-Host ("`r  [{0}{1}] {2,3}%  {3,-28}" -f ('#' * $n), ('.' * ($w - $n)), [int]($f * 100), $label) -NoNewline
}
function Done([string]$msg, [string]$color) {
    Write-Host ''; Write-Host "  $msg" -ForegroundColor $color; Write-Host ''
    [void](Read-Host '  Press Enter to exit'); exit
}

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

# ---------- header: DN logo (4 rows), DATA NOODLER (2 rows) and the version (YY_MMDD_HHMM) under it ----------
$ver = (Get-Date).ToString('yy_MMdd_HHmm')
$name = "$Prefix$ver"
Clear-Host
$logo = @('+----------+', '| |~\ |\ | |', '| |_/ | \| |', '+----------+')
$text = @("|~\  /\  ~|~  /\    |\ |  /~\  /~\  |~\  |    |~~  |~)", "|_/ /~~\  |  /~~\   | \|  \_/  \_/  |_/  |__  |__  |~\", "v.$ver", '')
Write-Host ''
for ($k = 0; $k -lt 4; $k++) {
    Write-Host "  $($logo[$k])" -ForegroundColor Blue -NoNewline
    Write-Host "   $($text[$k])" -ForegroundColor $(if ($k -lt 2) { 'Cyan' } else { 'DarkGray' })
}
Write-Host ''
Write-Host "  App folder: $Root" -ForegroundColor DarkGray
Write-Host "  Package   : $name.gz" -ForegroundColor DarkGray
Write-Host ''
[void](Read-Host '  Press Enter to package')
Write-Host ''

try {
    # scan
    Bar 0 'Scanning folders'
    $dirs = New-Object System.Collections.Generic.List[string]; $files = New-Object System.Collections.Generic.List[string]
    $stack = New-Object System.Collections.Generic.Stack[string]; $stack.Push($Root)
    while ($stack.Count -gt 0) {
        foreach ($e in (Get-ChildItem -LiteralPath $stack.Pop() -Force)) {
            $rel = $e.FullName.Substring($Root.Length + 1).Replace('\', '/')
            if ($e.PSIsContainer) {
                if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                if ($e.Name -eq '.git' -or (Test-Ignored $rel $true)) { continue }
                $dirs.Add($rel); $stack.Push($e.FullName)
            } else {
                if ($rel -like "$Prefix*.gz" -or $rel -eq "$($Prefix)Install.ps1" -or (Test-Ignored $rel $false)) { continue }
                $files.Add($rel)
            }
        }
    }
    $dirs.Sort([StringComparer]::Ordinal); $files.Sort([StringComparer]::Ordinal)

    # read every file and write the package text
    $entries = New-Object System.Collections.Generic.List[object]; $total = 0; $n = 0
    foreach ($rel in $files) {
        $b = [IO.File]::ReadAllBytes((Join-Path $Root ($rel.Replace('/', '\'))))
        $entries.Add(@{ Path = $rel; Bytes = $b; Sha = (Get-Hash $b) }); $total += $b.Length
        $n++; Bar (0.5 * $n / $files.Count) 'Reading files'
    }
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append("APP-PACKAGE v2`nCREATED $((Get-Date).ToString('s'))`nROOT $(Split-Path $Root -Leaf)`n")
    [void]$sb.Append("TOTALS folders=$($dirs.Count) files=$($entries.Count) bytes=$total`n--- TREE ---`n")
    foreach ($d in $dirs) { [void]$sb.Append("D $d`n") }
    foreach ($e in $entries) { [void]$sb.Append("F $($e.Bytes.Length) $($e.Path)`n") }
    [void]$sb.Append("--- CONTENT ---`n")
    $n = 0
    foreach ($e in $entries) {
        [void]$sb.Append("=== FILE $($e.Bytes.Length) $($e.Sha) $($e.Path)`n")
        $b64 = [Convert]::ToBase64String($e.Bytes)
        for ($i = 0; $i -lt $b64.Length; $i += 100) { [void]$sb.Append($b64, $i, [Math]::Min(100, $b64.Length - $i)).Append("`n") }
        $n++; Bar (0.5 + 0.2 * $n / $entries.Count) 'Encoding files'
    }
    [void]$sb.Append("=== END PACKAGE`n")

    # gzip, with the inner file name in its header (tools extract Data_Noodler_...txt)
    Bar 0.75 'Compressing'
    $data = $Utf8.GetBytes($sb.ToString())
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionLevel]::Optimal)
    $gz.Write($data, 0, $data.Length); $gz.Close()
    $g = $ms.ToArray(); $nm = [Text.Encoding]::ASCII.GetBytes("$name.txt" + [char]0)
    $out = New-Object byte[] ($g.Length + $nm.Length)
    [Array]::Copy($g, 0, $out, 0, 10); $out[3] = $out[3] -bor 8
    [Array]::Copy($nm, 0, $out, 10, $nm.Length); [Array]::Copy($g, 10, $out, 10 + $nm.Length, $g.Length - 10)
    $pkg = Join-Path $Root "$name.gz"
    [IO.File]::WriteAllBytes($pkg, $out)

    # verify: read the package back and compare every file with the one on disk
    $fs = [IO.File]::OpenRead($pkg)
    try { $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress); $ms = New-Object IO.MemoryStream; $gz.CopyTo($ms) } finally { $fs.Close() }
    $lines = $Utf8.GetString($ms.ToArray()).Split("`n")
    $i = [Array]::IndexOf($lines, '--- CONTENT ---') + 1
    $cur = $null; $sb = $null; $ok = 0; $bad = @(); $n = 0; $complete = $false
    for (; $i -lt $lines.Length; $i++) {
        $l = $lines[$i]
        if ($l -eq '=== END PACKAGE' -or $l.StartsWith('=== FILE ')) {
            if ($cur) {
                $disk = Join-Path $Root ($cur.Path.Replace('/', '\'))
                $h = Get-Hash ([Convert]::FromBase64String($sb.ToString()))
                if ($h -eq $cur.Sha -and (Get-Hash ([IO.File]::ReadAllBytes($disk))) -eq $cur.Sha) { $ok++ } else { $bad += $cur.Path }
                $n++; Bar (0.8 + 0.2 * $n / $entries.Count) 'Verifying package'
            }
            if ($l -eq '=== END PACKAGE') { $complete = $true; break }
            $p = $l.Substring(9) -split ' ', 3
            $cur = @{ Sha = $p[1]; Path = $p[2] }; $sb = New-Object Text.StringBuilder
        } elseif ($cur) { [void]$sb.Append($l) }
    }
    if (-not $complete) { $bad += '(package truncated)' }
    Bar 1 'Complete'
    Write-Host ''; Write-Host ''
    $pct = [Math]::Round(100.0 * $ok / [Math]::Max(1, $entries.Count), 2)
    $mb = [Math]::Round((Get-Item $pkg).Length / 1MB, 2)
    Write-Host ("  Folders: {0}   Files: {1}   Verified: {2}/{1} ({3}%)   Package: {4} MB" -f $dirs.Count, $entries.Count, $ok, $pct, $mb)
    if ($bad.Count) {
        foreach ($b in $bad | Select-Object -First 10) { Write-Host "    MISMATCH: $b" -ForegroundColor Red }
        Done 'Package finished with errors.' 'Red'
    }
    Write-Host "  Wrote $pkg"
    Done '100% - Package complete.' 'Green'
} catch {
    Write-Host ''; Done "Package failed: $($_.Exception.Message)" 'Red'
}
