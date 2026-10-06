# Rebuilds the project from a bundle made by tools/pack.ps1: every folder and file, byte-exact (SHA-256 checked).
# Usage: double-click build-project.bat next to data-noodler.bundle.txt (rebuilds into that folder), or
#   powershell -ExecutionPolicy Bypass -File build-project.ps1 [-Bundle <file>] [-Target <folder>] [-Force]
# -Force overwrites files that already exist in the target. No admin rights needed.
param([string]$Bundle = (Join-Path $PSScriptRoot 'data-noodler.bundle.txt'), [string]$Target = $PSScriptRoot, [switch]$Force)
$ErrorActionPreference = 'Stop'
$Bundle = (Resolve-Path $Bundle).Path
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
$Target = (Resolve-Path $Target).Path
$sha = [Security.Cryptography.SHA256]::Create()
$r = New-Object IO.StreamReader($Bundle, [Text.Encoding]::UTF8)
$ok = 0; $bad = 0; $skipped = 0; $expected = -1
try {
    if ($r.ReadLine() -ne 'DATA-NOODLER-BUNDLE v1') { throw 'Not a data-noodler bundle (first line is wrong).' }
    while ($null -ne ($line = $r.ReadLine())) {
        if ($line -like 'COUNT *') { $expected = [int]$line.Substring(6); continue }
        if ($line -eq 'BUNDLE-END') { break }
        if ($line -notlike 'FILE *') { continue }
        $parts = $line.Split(' ', 4)
        $hash = $parts[1]; $len = [long]$parts[2]; $rel = $parts[3]
        if ($rel -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($rel)) { throw "Unsafe path in bundle: $rel" }
        $sb = New-Object Text.StringBuilder
        while (($l = $r.ReadLine()) -ne 'END') { if ($null -eq $l) { throw "Bundle is cut off inside $rel" }; [void]$sb.Append($l.Trim()) }
        $bytes = [Convert]::FromBase64String($sb.ToString())
        $h = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
        if ($h -ne $hash -or $bytes.Length -ne $len) { Write-Host "CHECKSUM FAILED: $rel" -ForegroundColor Red; $bad++; continue }
        $dest = Join-Path $Target ($rel -replace '/', '\')
        if ((Test-Path -LiteralPath $dest) -and -not $Force) { Write-Host "exists, skipped (use -Force): $rel" -ForegroundColor Yellow; $skipped++; continue }
        $dir = Split-Path $dest -Parent
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllBytes($dest, $bytes)
        $ok++
    }
} finally { $r.Close() }
Write-Host "Written: $ok   Skipped: $skipped   Failed: $bad   (bundle lists $expected)"
if ($bad -gt 0 -or ($expected -ge 0 -and $ok + $skipped -ne $expected)) { Write-Host 'The bundle is damaged or incomplete. Copy it again.' -ForegroundColor Red; exit 1 }
Write-Host "Project rebuilt in $Target" -ForegroundColor Green
