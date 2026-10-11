# Arrow working format: writes the same data as an Arrow dataset and as a Parquet dataset and checks every query
# gives the same answer (all types, NULLs, Unicode, decimals, several parts / batches, column pruning, empty data),
# then checks resident (in-memory) datasets: same answers, background load, stale detection after a rewrite.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\arrow-format.ps1
# Data goes to temp\ and projects\_arrowtest_*\ (both removed at the end). ASCII only (PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '.server\engine-loader.ps1')
Write-Host ('Engine: ' + (Load-DataEngine -Root $root))
$engine = New-DataEngine -Root $root -MaxWorkers 8
$engine.Options.PartRows = 100000        # several part files
$engine.Options.BatchRowCount = 40000    # several batches per part
$tag = [guid]::NewGuid().ToString('N').Substring(0, 6)
$tmp = "temp/arrowtest-$tag"
$proj = "projects/_arrowtest_$tag"
$none = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$ct = [Threading.CancellationToken]::None
$script:pass = 0; $script:fail = 0

function Rows($sql, $views) {
  if (-not $views) { $views = $none }
  $r = $engine.Query($sql, $views, 1000000, 0, $ct)
  $sb = New-Object Text.StringBuilder
  foreach ($b in $r.Batches) { for ($i = 0; $i -lt $b.Rows; $i++) { for ($c = 0; $c -lt $b.Cols.Length; $c++) { $v = [NativeDataEngine.Values]::Text($b.Cols[$c], $i); [void]$sb.Append($(if ($null -eq $v) { '<null>' } else { $v })).Append('|') }; [void]$sb.Append("`n") } }
  $types = (@($r.Schema.Fields | ForEach-Object { $_.Name + ':' + $_.Type.Name }) -join ',')
  return @{ text = $sb.ToString(); rows = $r.Rows; types = $types }
}
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  ok   $name" } else { $script:fail++; Write-Host "  FAIL $name $detail" -ForegroundColor Red }
}
function WriteDs([string]$sql, [string]$dest, [string]$fmt) {
  $engine.Options.DatasetFormat = $fmt
  $j = $engine.StartWrite($sql, $none, $dest, $null, 1, 0)
  [void]$j.WaitDone(600000)
  if ($j.State -ne 'done') { throw "write $dest failed: $($j.Error.Message)" }
  return $j.Result
}

$u = 'h' + [char]0xE9 + 'llo ' + [char]0x2713 + ' ' + [char]0x65E5 + [char]0x672C + ' "q" a,b'
$src = @"
SELECT range AS id,
  CAST(range % 128 - 64 AS TINYINT) AS t8,
  CAST(range % 30000 AS SMALLINT) AS t16,
  CAST(range AS INTEGER) AS t32,
  CASE WHEN range % 7 = 0 THEN NULL ELSE range * 3000000000 END AS big,
  CASE WHEN range % 11 = 0 THEN NULL ELSE range / 3.0 END AS dbl,
  CAST(range / 100.0 - 500 AS DECIMAL(12,2)) AS dec,
  CAST(range * 1.5 AS DECIMAL(30,4)) AS bigdec,
  CASE WHEN range % 5 = 0 THEN NULL ELSE 'txt-' || CAST(range AS VARCHAR) END AS s,
  CASE WHEN range % 3 = 0 THEN '$u' ELSE '' END AS u,
  CASE WHEN range % 13 = 0 THEN NULL ELSE range % 2 = 0 END AS b,
  CAST(NULL AS VARCHAR) AS allnull,
  CAST(CAST('2020-01-01' AS DATE) + CAST(range % 1000 AS INTEGER) AS DATE) AS d,
  CASE WHEN range % 17 = 0 THEN NULL ELSE add_seconds(CAST('2020-01-01 00:00:00' AS TIMESTAMP), range * 37) END AS ts
FROM range(250001)
"@

try {
  Write-Host 'Round trip: Arrow vs Parquet dataset'
  $mA = WriteDs $src "$tmp/ar" 'arrow'
  $mP = WriteDs $src "$tmp/pq" 'parquet'
  Check 'arrow manifest format' ($mA['format'] -eq 'arrow') $mA['format']
  Check 'arrow parts are .arrow' (@($mA['files'] | Where-Object { $_ -notlike '*.arrow' }).Count -eq 0)
  Check 'several parts' (@($mA['files']).Count -ge 3) (@($mA['files']).Count)
  Check 'row counts' ($mA['rowCount'] -eq 250001 -and $mP['rowCount'] -eq 250001)
  $orig = Rows "$src ORDER BY id"
  $qs = @(
    'SELECT * FROM T ORDER BY id',
    'SELECT count(*) FROM T',
    'SELECT id, s FROM T WHERE id % 1000 = 1 ORDER BY id',
    'SELECT b, count(*), sum(big), avg(dbl), min(dec), max(bigdec), min(d), max(ts) FROM T GROUP BY b ORDER BY b',
    'SELECT u, count(*) FROM T GROUP BY u ORDER BY u',
    'SELECT count(allnull), count(s), count(dbl), count(ts) FROM T',
    'SELECT t8, t16, t32 FROM T WHERE t8 < -60 ORDER BY id LIMIT 50',
    'SELECT * FROM T WHERE 1 = 0'
  )
  foreach ($q in $qs) {
    $a = Rows ($q.Replace('FROM T', "FROM read_dataset('$tmp/ar')"))
    $p = Rows ($q.Replace('FROM T', "FROM read_dataset('$tmp/pq')"))
    Check "same answer: $q" ($a.text -eq $p.text -and $a.types -eq $p.types) "rows $($a.rows) vs $($p.rows); types $($a.types) vs $($p.types)"
  }
  $a = Rows "SELECT * FROM read_dataset('$tmp/ar') ORDER BY id"
  Check 'arrow = source query (values)' ($a.text -eq $orig.text)
  Check 'old name read_parquet() reads an Arrow dataset' ((Rows "SELECT count(*) FROM read_parquet('$tmp/ar')").text -eq "250001|`n")

  $e1 = WriteDs "SELECT * FROM read_dataset('$tmp/ar') WHERE 1 = 0" "$tmp/empty" 'arrow'
  $e = Rows "SELECT * FROM read_dataset('$tmp/empty')"
  Check 'empty dataset keeps schema' ($e.rows -eq 0 -and $e.types -eq $a.types) $e.types

  Write-Host 'Exports from an Arrow dataset'
  foreach ($fmt in 'parquet', 'csv', 'sqlite') {
    $jb = New-Object NativeDataEngine.Job('export', 'test')
    $res = $engine.Export($jb, "SELECT * FROM read_dataset('$tmp/ar')", $none, "$tmp/out.$fmt", $fmt, 't')
    Check "export $fmt" ($res['rows'] -eq 250001) "$($res['rows'])"
  }
  $x = Rows "SELECT * FROM read_parquet('$tmp/out.parquet') ORDER BY id"
  Check 'parquet export = arrow data' ($x.text -eq $a.text)
  # SQLite read in parallel (rowid ranges): same values in the same order as the source (no ORDER BY on purpose).
  $sq = "SELECT range AS id, CAST(range * 7 % 1000 AS INTEGER) AS v, range / 4.0 AS f, CASE WHEN range % 9 = 0 THEN NULL ELSE 'r' || CAST(range % 777 AS VARCHAR) END AS s FROM range(600000)"
  $jb = New-Object NativeDataEngine.Job('export', 'test')
  [void]$engine.Export($jb, $sq, $none, "$tmp/big.sqlite", 'sqlite', 't')
  $want = Rows "$sq"
  $got = Rows "SELECT * FROM read_sqlite('$tmp/big.sqlite', 't')"
  Check 'SQLite parallel read = source (values and order)' ($got.text -eq $want.text) "rows $($got.rows) vs $($want.rows)"
  $one = $engine.Query("SELECT count(*), sum(v), max(s) FROM read_sqlite('$tmp/big.sqlite', 't')", $none, 0, 1, $ct)
  $many = $engine.Query("SELECT count(*), sum(v), max(s) FROM read_sqlite('$tmp/big.sqlite', 't')", $none, 0, 0, $ct)
  $t1 = (0..2 | % { [NativeDataEngine.Values]::Text($one.Batches[0].Cols[$_], 0) }) -join '|'; $t2 = (0..2 | % { [NativeDataEngine.Values]::Text($many.Batches[0].Cols[$_], 0) }) -join '|'
  Check 'SQLite 1 worker = all workers' ($t1 -eq $t2) "$t1 vs $t2"

  Write-Host 'Resident datasets (engine memory)'
  $ds = "$proj/data/source/CLEAN_t"
  [void](WriteDs $src $ds 'arrow')
  $q = "SELECT b, count(*), sum(big), avg(dbl), max(u) FROM read_dataset('$ds') GROUP BY b ORDER BY b"
  $first = Rows $q
  for ($i = 0; $i -lt 300 -and @($engine.Resident.Info()['datasets']).Count -eq 0; $i++) { Start-Sleep -Milliseconds 100 }
  $info = $engine.Resident.Info()
  Check 'loaded into memory in the background' (@($info['datasets']).Count -eq 1) ($info | ConvertTo-Json -Depth 4)
  $second = Rows $q
  $hits = $engine.Resident.Info()['datasets'][0]['hits']
  Check 'memory answer = disk answer' ($first.text -eq $second.text)
  Check 'second query read memory' ($hits -ge 1) "hits $hits"
  $all1 = Rows "SELECT * FROM read_dataset('$ds') ORDER BY id"
  Check 'memory full scan = source' ($all1.text -eq $orig.text)
  $M = "read_dataset('$ds')"
  $mq = @(
    "SELECT s, count(*) FROM $M GROUP BY s ORDER BY count(*) DESC, s LIMIT 20",
    "SELECT count(DISTINCT s), count(DISTINCT u), min(s), max(s) FROM $M",
    "SELECT a.id, a.s, b.s FROM $M a JOIN $M b ON a.id = b.id + 1 WHERE a.id % 5000 = 1 ORDER BY a.id",
    "SELECT id, s, row_number() OVER (PARTITION BY u ORDER BY id DESC) AS r FROM $M WHERE id % 997 = 0 ORDER BY id",
    "SELECT * FROM $M WHERE s LIKE 'txt-12%' ORDER BY dbl DESC LIMIT 30",
    "CREATE TABLE t AS SELECT id, s, u FROM $M WHERE id < 2000; UPDATE t SET s = upper(s) WHERE id % 2 = 0; SELECT count(*), max(s), min(s) FROM t",
    "SELECT DISTINCT u FROM $M ORDER BY u",
    "SELECT d, count(*), string_agg(DISTINCT CAST(t8 AS VARCHAR), ',') FROM $M WHERE id < 3000 GROUP BY d ORDER BY d LIMIT 5"
  )
  $onAns = @(); foreach ($q in $mq) { $onAns += (Rows $q).text }
  $hitsOn = $engine.Resident.Info()['datasets'][0]['hits']
  $engine.Options.ResidentFraction = 0
  for ($k = 0; $k -lt $mq.Count; $k++) { $offAns = (Rows $mq[$k]).text; Check "memory = disk: $($mq[$k].Substring(0, [Math]::Min(70, $mq[$k].Length)))" ($onAns[$k] -eq $offAns) }
  $engine.Options.ResidentFraction = 0.6
  Check 'those queries read memory' ($hitsOn -ge $mq.Count) "hits $hitsOn"
  [void](WriteDs "SELECT * FROM read_dataset('$ds') WHERE id < 10" $ds 'arrow')
  $after = Rows "SELECT count(*) FROM read_dataset('$ds')"
  Check 'rewrite is seen at once (no stale memory)' ($after.text -eq "10|`n") $after.text
  $engine.Options.ResidentFraction = 0
  $off = Rows $q
  Check 'resident off still works' ($off.rows -ge 1)
  $engine.Options.ResidentFraction = 0.6
  $engine.Resident.DropUnder($null) | Out-Null
} catch {
  $script:fail++; Write-Host "  FAIL exception: $($_.Exception.Message)" -ForegroundColor Red
  $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException; Write-Host "       $($ex.Message)" }
} finally {
  $engine.Dispose()
  foreach ($p in $tmp, $proj) { $full = Join-Path $root $p; if (Test-Path $full) { Remove-Item -Recurse -Force $full } }
}
Write-Host ''
Write-Host "Passed $script:pass, failed $script:fail"
if ($script:fail -gt 0) { exit 1 }
