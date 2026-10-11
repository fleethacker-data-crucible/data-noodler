# Old vs new engine: makes the test CSVs once, checks out the old engine (git worktree of -OldRef) and runs
# tests\bench-engine.ps1 in a fresh process per configuration. Results: temp\bench\results.json (+ one file each).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\bench-compare.ps1 [-Rows 10000000] [-OldRef 7594849]
# ASCII only (Windows PowerShell 5.1).
param([long]$Rows = 10000000, [string]$OldRef = '7594849', [int]$Runs = 3, [switch]$KeepData, [string[]]$Only = @(), [string]$Tag = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root 'temp\bench'
New-Item -ItemType Directory -Force $work | Out-Null
$csv = Join-Path $work "fact_$Rows.csv"; $dimCsv = Join-Path $work 'dim.csv'
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path $csv) -or -not (Test-Path $dimCsv)) {
  Write-Host "Generating $Rows-row fact CSV and 10,000-row dimension CSV..."
  $gen = @"
. '$root\.server\engine-loader.ps1'
[void](Load-DataEngine -Root '$root')
`$e = New-DataEngine -Root '$root'
`$v = New-Object 'System.Collections.Generic.Dictionary[string,string]'
function Ex(`$sql, `$to) { `$j = New-Object NativeDataEngine.Job('export','gen'); [void]`$e.Export(`$j, `$sql, `$v, `$to, 'csv', 't') }
Ex "SELECT range AS order_id, range % 10000 AS store_id, 'S' || CAST(range % 10000 AS VARCHAR) AS store_key, 'C' || CAST((range * 7919) % 1000000 AS VARCHAR) AS customer, 'R' || CAST(range % 8 AS VARCHAR) AS region, 'K' || CAST(range % 25 AS VARCHAR) AS category, (range * 31) % 100 + 1 AS qty, ((range * 7) % 10000) / 100.0 AS price, CASE WHEN range % 20 = 0 THEN NULL ELSE ((range * 13) % 30) / 100.0 END AS discount, CAST(CAST('2020-01-01' AS DATE) + CAST(range % 1500 AS INTEGER) AS DATE) AS order_date, CASE WHEN range % 20 = 1 THEN NULL ELSE 'note ' || CAST(range % 100 AS VARCHAR) END AS note FROM range($Rows)" 'temp/bench/fact_$Rows.csv'
Ex "SELECT range AS store_id, 'SEG' || CAST(range % 12 AS VARCHAR) AS segment, CASE WHEN range % 3 = 0 THEN 'A' WHEN range % 3 = 1 THEN 'B' ELSE 'C' END AS tier FROM range(10000)" 'temp/bench/dim.csv'
`$e.Dispose()
"@
  $genFile = Join-Path $work 'gen.ps1'; [IO.File]::WriteAllText($genFile, $gen)
  & $ps -NoProfile -ExecutionPolicy Bypass -File $genFile
  if ($LASTEXITCODE -ne 0) { throw 'CSV generation failed.' }
}
Write-Host ("Fact CSV: {0:N0} MB" -f ((Get-Item $csv).Length / 1MB))

$old = Join-Path $env:TEMP "dn-old-engine-$OldRef"
if (-not (Test-Path (Join-Path $old 'engine'))) {
  if (Test-Path $old) { git -C $root worktree remove --force $old 2>$null; Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
  git -C $root worktree add --detach $old $OldRef | Out-Null
}

$configs = @(
  @{ label = 'OLD engine (Parquet, disk)'; root = $old; format = 'parquet'; memory = $false; file = 'old.json' },
  @{ label = 'NEW engine, Parquet on disk'; root = $root; format = 'parquet'; memory = $false; file = 'new-parquet.json' },
  @{ label = 'NEW engine, Arrow on disk'; root = $root; format = 'arrow'; memory = $false; file = 'new-arrow.json' },
  @{ label = 'NEW engine, Arrow + memory'; root = $root; format = 'arrow'; memory = $true; file = 'new-arrow-mem.json' }
)
# -Only old,new-parquet,...: run just those (by file name); the others are taken from earlier result files if present.
$Only = @($Only | ForEach-Object { $_ -split "," } | Where-Object { $_ })   # -File passes "a,b" as one string
$all = @()
foreach ($c in $configs) {
  $out = Join-Path $work $c.file
  if ($Only.Count -gt 0 -and $Only -notcontains $c.file.Replace('.json', '')) {
    if (Test-Path $out) { $all += (Get-Content $out -Raw | ConvertFrom-Json) }
    continue
  }
  Write-Host ''; Write-Host "=== $($c.label) ==="
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'tests\bench-engine.ps1'), '-Root', $c.root, '-Format', $c.format, '-Csv', $csv, '-DimCsv', $dimCsv, '-Label', $c.label, '-Runs', $Runs, '-Out', $out)
  if ($c.memory) { $args += '-Memory' }
  & $ps @args
  if ($LASTEXITCODE -ne 0) { throw "Benchmark failed: $($c.label)" }
  $all += (Get-Content $out -Raw | ConvertFrom-Json)
}
$summary = [ordered]@{ when = (Get-Date).ToString('s'); machine = [ordered]@{ cores = [Environment]::ProcessorCount; ramGB = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1); ps = $PSVersionTable.PSVersion.ToString(); clr = [Environment]::Version.ToString(); is64 = [Environment]::Is64BitProcess }; rows = $Rows; csvBytes = (Get-Item $csv).Length; oldRef = $OldRef; configs = $all }
$name = if ($Tag) { "results-$Tag.json" } else { 'results.json' }
[IO.File]::WriteAllText((Join-Path $work $name), ($summary | ConvertTo-Json -Depth 7))
Write-Host ''; Write-Host "Results: $work\$name"
if (Test-Path $old) { git -C $root worktree remove --force $old 2>$null }
if (-not $KeepData) { Remove-Item $csv, $dimCsv -ErrorAction SilentlyContinue }
