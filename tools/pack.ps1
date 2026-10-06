# Packs the project into ONE text file (data-noodler.bundle.txt) that build-project.ps1 turns back
# into the exact folder tree. Files = what git tracks (no data, .git, .trash). Byte-exact: Base64 + SHA-256.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\pack.ps1 [-Out <path>]
param([string]$Out)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Out) { $Out = Join-Path $root 'data-noodler.bundle.txt' }
Push-Location $root
try { $files = @(git ls-files) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } } finally { Pop-Location }
$sha = [Security.Cryptography.SHA256]::Create()
$w = New-Object IO.StreamWriter($Out, $false, (New-Object Text.UTF8Encoding($false)))
try {
    $w.WriteLine('DATA-NOODLER-BUNDLE v1')
    $w.WriteLine("CREATED $((Get-Date).ToString('s'))")
    $w.WriteLine("COUNT $($files.Count)")
    foreach ($f in $files) {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $root $f))
        $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
        $w.WriteLine("FILE $hash $($bytes.Length) $f")
        $b64 = [Convert]::ToBase64String($bytes)
        for ($i = 0; $i -lt $b64.Length; $i += 100) { $w.WriteLine($b64.Substring($i, [Math]::Min(100, $b64.Length - $i))) }
        $w.WriteLine('END')
    }
    $w.WriteLine('BUNDLE-END')
} finally { $w.Close() }
Write-Host "Packed $($files.Count) files into $Out ($([Math]::Round((Get-Item $Out).Length / 1MB, 2)) MB)"
