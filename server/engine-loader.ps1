# Compiles the C# engine (server\data-engine\**\*.cs) with Add-Type and loads it. Dot-sourced by server.ps1 and tests.
# The compiled DLL is cached in <root>\temp\data-engine\ keyed by a hash of the sources, so a
# restart without source changes loads in well under a second. Only .NET Framework assemblies are referenced.
# ASCII only (Windows PowerShell 5.1 reads .ps1 files as ANSI).

function Get-EngineSourceHash([string]$Root) {
    $files = @(Get-ChildItem (Join-Path $Root 'server\data-engine') -Filter *.cs -Recurse | Sort-Object FullName)
    if (-not $files) { throw 'No C# engine source files were found in server\data-engine\.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    $ms = New-Object IO.MemoryStream
    foreach ($f in $files) {
        $b = [IO.File]::ReadAllBytes($f.FullName)
        $n = [Text.Encoding]::UTF8.GetBytes($f.FullName.Substring($Root.Length))
        $ms.Write($n, 0, $n.Length); $ms.Write($b, 0, $b.Length)
    }
    $v = [Text.Encoding]::UTF8.GetBytes("$([Environment]::Version)|$([IntPtr]::Size)")
    $ms.Write($v, 0, $v.Length)
    $h = ($sha.ComputeHash($ms.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join ''
    return @{ files = $files; hash = $h.Substring(0, 16) }
}

# Every temporary file of this process (compiler scratch files, .NET Path.GetTempPath) goes to <root>\temp\sys.
function Use-RootTemp([string]$Root) {
    $t = Join-Path $Root 'temp\sys'
    New-Item -ItemType Directory -Force $t | Out-Null
    $env:TEMP = $t; $env:TMP = $t
}

function Load-DataEngine {
    param([Parameter(Mandatory = $true)][string]$Root, [switch]$Force)
    if (-not $Force -and ('NativeDataEngine.DataEngine' -as [type])) { return 'already loaded' }
    $src = Get-EngineSourceHash $Root
    Use-RootTemp $Root
    $cacheDir = Join-Path $Root 'temp\data-engine'
    New-Item -ItemType Directory -Force $cacheDir | Out-Null
    $dll = Join-Path $cacheDir "NativeDataEngine-$($src.hash).dll"
    if (-not $Force -and (Test-Path $dll)) {
        Add-Type -Path $dll
        return "cached ($($src.files.Count) files)"
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $cp = New-Object CodeDom.Compiler.CompilerParameters
    $cp.OutputAssembly = $dll
    $cp.GenerateInMemory = $false
    $cp.GenerateExecutable = $false
    $cp.IncludeDebugInformation = $false
    $cp.CompilerOptions = '/optimize+ /nowarn:1591,0162,0168,0219,0414,0649,0169'
    foreach ($a in 'System.dll', 'System.Core.dll', 'System.Data.dll', 'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'System.Numerics.dll') {
        [void]$cp.ReferencedAssemblies.Add($a)
    }
    try {
        Add-Type -Path ($src.files | ForEach-Object FullName) -CompilerParameters $cp -ErrorAction Stop
    } catch {
        $msg = $_.Exception.Message
        throw "Engine compile failed: $msg"
    }
    if (-not ('NativeDataEngine.DataEngine' -as [type])) { Add-Type -Path $dll }
    # Old cached builds are no longer needed.
    Get-ChildItem $cacheDir -Filter 'NativeDataEngine-*.dll' | Where-Object { $_.FullName -ne $dll } | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }
    return "compiled $($src.files.Count) files in $($sw.ElapsedMilliseconds) ms"
}

function New-DataEngine {
    param([Parameter(Mandatory = $true)][string]$Root, [int]$MaxWorkers = 64, [double]$MemoryFraction = 0.5, [long]$MemoryLimitBytes = 0)
    $o = New-Object NativeDataEngine.EngineOptions
    $o.RootPath = $Root
    $o.WorkspacePath = Join-Path $Root 'temp'
    $o.MaxWorkers = $MaxWorkers
    $o.MemoryFraction = $MemoryFraction
    $o.MemoryLimitBytes = $MemoryLimitBytes
    return New-Object NativeDataEngine.DataEngine($o)
}
