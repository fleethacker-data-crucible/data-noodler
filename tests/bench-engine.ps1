# Engine benchmark: one configuration per process, results as JSON (tests\bench-compare.ps1 runs them all and
# builds the comparison). Keep it: it is the regression test for engine speed.
#   -Root     engine source + project root to run (lets an older checkout be measured too)
#   -Format   dataset parts: arrow | parquet   (ignored by engines without EngineOptions.DatasetFormat)
#   -Memory   resident datasets on (engine memory) / off (read from disk every query)
#   -Csv      the generated fact CSV; -DimCsv the dimension CSV (tests\bench-compare.ps1 makes both)
# Steps: import CSV -> dataset, then filter / calculations / group by / join / sort / window / distinct on the dataset,
# write a derived dataset, export Parquet + CSV. Each query step runs -Runs times; the median is reported.
# ASCII only (Windows PowerShell 5.1).
param([Parameter(Mandatory = $true)][string]$Root, [string]$Format = 'arrow', [switch]$Memory, [Parameter(Mandatory = $true)][string]$Csv,
  [Parameter(Mandatory = $true)][string]$DimCsv, [string]$Label = '', [int]$Runs = 3, [string]$Out = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $Root '.server\engine-loader.ps1')
$load = Load-DataEngine -Root $Root
$engine = New-DataEngine -Root $Root -MaxWorkers 64
$o = $engine.Options
$hasFormat = $null -ne ($o | Get-Member -Name DatasetFormat)
if ($hasFormat) { $o.DatasetFormat = $Format; $o.ResidentFraction = $(if ($Memory) { 0.6 } else { 0 }) }
$none = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$ct = [Threading.CancellationToken]::None
$proj = 'projects/_bench_' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$fact = "$proj/data/staged/FACT"; $dim = "$proj/data/staged/DIM"
$proc = [Diagnostics.Process]::GetCurrentProcess()
$results = New-Object System.Collections.Generic.List[object]

function Step([string]$name, [long]$rows, [scriptblock]$fn, [int]$n = 1) {
  $times = @()
  $last = $null
  for ($i = 0; $i -lt $n; $i++) {
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $last = & $fn
    $sw.Stop(); $times += $sw.Elapsed.TotalMilliseconds
  }
  $sorted = @($times | Sort-Object); $ms = $sorted[[int][Math]::Floor($sorted.Count / 2)]
  $proc.Refresh()
  $r = [ordered]@{ step = $name; ms = [Math]::Round($ms, 1); first = [Math]::Round($times[0], 1); rows = $rows; rowsPerSec = $(if ($ms -gt 0) { [long]($rows / ($ms / 1000.0)) } else { 0 }); peakMB = [long]($proc.PeakWorkingSet64 / 1MB); check = "$last" }
  $results.Add($r)
  Write-Host ("  {0,-34} {1,10:N1} ms  {2,14:N0} rows/s  {3}" -f $name, $r.ms, $r.rowsPerSec, $r.check)
}
function Q([string]$sql) {
  $r = $engine.Query($sql, $none, 0, 0, $ct)
  $b = $r.Batches[0]; if (-not $b -or $b.Rows -eq 0) { return "$($r.Rows) rows" }
  $v = [NativeDataEngine.Values]::Text($b.Cols[0], 0); return "$($r.Rows) rows, first=$v"
}
function W([string]$sql, [string]$dest) {
  $j = $engine.StartWrite($sql, $none, $dest, $null, 1, 0)
  [void]$j.WaitDone(3600000)
  if ($j.State -ne 'done') { throw "write failed: $($j.Error.Message)" }
  return "$($j.Result['rowCount']) rows, $([long]($j.Result['bytes'] / 1MB)) MB"
}
function X([string]$sql, [string]$to, [string]$fmt) {
  $jb = New-Object NativeDataEngine.Job('export', 'bench')
  $r = $engine.Export($jb, $sql, $none, $to, $fmt, 't')
  return "$($r['rows']) rows, $([long]($r['bytes'] / 1MB)) MB"
}

try {
  $csvLit = $Csv.Replace("'", "''"); $dimLit = $DimCsv.Replace("'", "''")
  $N = [long]($engine.Query("SELECT count(*) FROM read_csv('$csvLit')", $none, 0, 0, $ct).Batches[0].Cols[0].I[0])
  $D = [long]($engine.Query("SELECT count(*) FROM read_csv('$dimLit')", $none, 0, 0, $ct).Batches[0].Cols[0].I[0])
  Write-Host "$Label  server GC: $([Runtime.GCSettings]::IsServerGC)  engine: $load  format: $(if ($hasFormat) { $Format } else { 'parquet (old engine)' })  memory: $([bool]$Memory)  rows: $N"
  Step 'Import CSV -> dataset (write)' $N { W "SELECT * FROM read_csv('$csvLit')" $fact }
  [void](W "SELECT * FROM read_csv('$dimLit')" $dim)
  $F = "read_dataset('$fact')"; $DD = "read_dataset('$dim')"
  if (-not $hasFormat) { $F = "read_parquet('$fact')"; $DD = "read_parquet('$dim')" }
  if ($Memory -and $hasFormat) {
    Step 'Load into engine memory' $N { $r = $engine.Resident.Preload([string[]]@($fact, $dim), 3600000); "$($r[0]['state']) $($r[0]['bytes'])" }
  }
  Step 'Full scan count(*) WHERE' $N { Q "SELECT count(*) FROM $F WHERE price > 50" } $Runs
  Step 'Filter numeric + 2 columns' $N { Q "SELECT count(*), sum(qty) FROM $F WHERE price > 50 AND qty < 40 AND discount IS NOT NULL" } $Runs
  Step 'Calculations (6 expressions)' $N { Q "SELECT sum(qty * price * (1 - coalesce(discount, 0))), avg(price / (qty + 1)), max(abs(price - 50) * 2), min(round(price * 1.07, 2)), sum(CASE WHEN qty > 50 THEN 1 ELSE 0 END), avg(length(customer)) FROM $F" } $Runs
  Step 'GROUP BY 10k key, sum+count' $N { Q "SELECT store_key, sum(qty), count(*) FROM $F GROUP BY store_key" } $Runs
  Step 'GROUP BY 2 cols, 5 aggregates' $N { Q "SELECT region, category, count(*), sum(qty * price), avg(price), min(order_date), max(discount) FROM $F GROUP BY region, category" } $Runs
  Step 'COUNT DISTINCT high-card text' $N { Q "SELECT count(DISTINCT customer) FROM $F" } $Runs
  Step 'Hash join fact x dim + group' $N { Q "SELECT d.segment, sum(f.qty * f.price), count(*) FROM $F f JOIN $DD d ON f.store_id = d.store_id GROUP BY d.segment" } $Runs
  Step 'Join + filter both sides' $N { Q "SELECT count(*), avg(f.price) FROM $F f JOIN $DD d ON f.store_id = d.store_id WHERE d.tier = 'A' AND f.qty > 20" } $Runs
  Step 'ORDER BY double LIMIT 100' $N { Q "SELECT order_id, price FROM $F ORDER BY price DESC, order_id LIMIT 100" } $Runs
  Step 'Window: rank per key (1/10 rows)' ([long]($N / 10)) { Q "SELECT max(r) FROM (SELECT row_number() OVER (PARTITION BY store_key ORDER BY price DESC) AS r FROM $F WHERE order_id % 10 = 0) t" } $Runs
  Step 'Preview top 100 + count' $N { $c = 0L; $r = $engine.Preview("SELECT * FROM $F WHERE qty > 10", $none, 100, 0, $ct, [ref]$c); "$($r.Rows) rows, count=$c" } $Runs
  Step 'Transform write (filter+calc)' $N { W "SELECT order_id, store_id, qty * price AS amount, upper(region) AS region, order_date FROM $F WHERE qty > 5" "$proj/data/source/CLEAN_OUT" }
  Step 'Export Parquet (Snappy)' $N { X "SELECT * FROM $F" "$proj/publish/fact.parquet" 'parquet' }
  Step 'Export CSV' $N { X "SELECT * FROM $F" "$proj/publish/fact.csv" 'csv' }
  $sizes = @{}
  foreach ($p in $fact, $dim) { $sizes[$p] = [long]((Get-ChildItem (Join-Path $Root $p) -File | Measure-Object Length -Sum).Sum) }
  $proc.Refresh()
  $doc = [ordered]@{ label = $Label; engine = $load; format = $(if ($hasFormat) { $Format } else { 'parquet' }); memory = [bool]$Memory; rows = $N; dimRows = $D
    serverGC = [Runtime.GCSettings]::IsServerGC; factBytesOnDisk = $sizes[$fact]; peakMB = [long]($proc.PeakWorkingSet64 / 1MB); workers = $engine.WorkerCount; steps = $results }
  $json = $doc | ConvertTo-Json -Depth 5
  if ($Out) { [IO.File]::WriteAllText($Out, $json) } else { $json }
} finally {
  $engine.Dispose()
  $full = Join-Path $Root $proj; if (Test-Path $full) { Remove-Item -Recurse -Force $full }
}
