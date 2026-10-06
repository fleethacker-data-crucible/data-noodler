# Native engine test suite. Run:  powershell -NoProfile -ExecutionPolicy Bypass -File tests\engine-tests.ps1 [-Big]
# Writes scratch data to temp\engine-tests\ (git-ignored data files). ASCII only.
param([switch]$Big)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '.server\engine-loader.ps1')
Write-Host ("Load: " + (Load-DataEngine -Root $root))
$e = New-DataEngine -Root $root
$work = 'temp/engine-tests'
$workFull = Join-Path $root 'temp\engine-tests'
if (Test-Path $workFull) { Remove-Item $workFull -Recurse -Force }
New-Item -ItemType Directory -Force $workFull | Out-Null

$script:pass = 0; $script:fail = 0; $script:failed = @()
function Ok($name, [bool]$cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "  ok   $name" -ForegroundColor Green }
    else { $script:fail++; $script:failed += $name; Write-Host "  FAIL $name  $detail" -ForegroundColor Red }
}
function V { $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase); foreach ($k in $args[0].Keys) { $d[$k] = $args[0][$k] }; return $d }
$none = V @{}
function Inner($ex) { while ($ex.InnerException) { $ex = $ex.InnerException }; return $ex }
# Query -> rows as array of arrays (via the API's JSON, so values are what the browser sees).
function Q($sql, $views = $none, [int]$workers = 0, [int]$limit = 0) {
    $r = $e.Query($sql, $views, $limit, $workers, [Threading.CancellationToken]::None)
    return ([NativeDataEngine.EngineApi]::ResultJson($r) | ConvertFrom-Json)
}
# Rows as compact JSON text (PowerShell 5.1's ConvertTo-Json mangles nested arrays).
function Rows($sql, $views = $none, [int]$workers = 0) {
    $r = $e.Query($sql, $views, 0, $workers, [Threading.CancellationToken]::None)
    return [NativeDataEngine.Json]::Write(([NativeDataEngine.Json]::Parse([NativeDataEngine.EngineApi]::ResultJson($r)))['rows'])
}
function RowCount($sql, $views = $none) { return (Q $sql $views).rowCount }
function One($sql, $views = $none) { return (Q $sql $views).rows[0][0] }
function ErrCode($sql, $views = $none) {
    try { Q $sql $views | Out-Null; return 'none' } catch { $x = Inner $_.Exception; if ($x -is [NativeDataEngine.EngineException]) { return $x.Code } return $x.GetType().Name + ': ' + $x.Message }
}
function Job($kind, [scriptblock]$fn) {
    $j = New-Object NativeDataEngine.Job($kind, 'test')
    return & $fn $j
}
function WriteDs($sql, $dest, $views = $none, [int]$codec = 1, [int]$workers = 0) {
    $j = New-Object NativeDataEngine.Job('write', $dest)
    return $e.Write($j, $sql, $views, $dest, $null, $codec, $workers)
}
function J($o) { if ($o -is [string]) { return $o }; return ($o | ConvertTo-Json -Compress -Depth 5) }
function Write-Text($rel, $text, [switch]$Bom) {
    $enc = New-Object Text.UTF8Encoding($Bom.IsPresent)
    [IO.File]::WriteAllText((Join-Path $root ($rel -replace '/', '\')), $text, $enc)
}

Write-Host "`n== CSV parsing"
Write-Text "$work/tricky.csv" ("id,name,amount,day,flag,code,note`r`n" +
    "1,""Smith, John"",10.5,2024-01-02,true,007,""said """"hi""""""`r`n" +
    "2,Ann,,2024-02-03,false,010,""multi`r`nline""`r`n" +
    "3,""Bob"",-3,,true,123,`r`n") -Bom
$r = Q "SELECT * FROM read_csv('$work/tricky.csv')"
Ok 'header + 7 columns' ($r.cols.Count -eq 7 -and $r.cols[1] -eq 'name')
Ok 'types inferred' (($r.types -join ',') -eq 'BIGINT,VARCHAR,DOUBLE,DATE,BOOLEAN,VARCHAR,VARCHAR') ($r.types -join ',')
Ok 'quoted delimiter' ($r.rows[0][1] -eq 'Smith, John')
Ok 'doubled quotes' ($r.rows[0][6] -eq 'said "hi"') $r.rows[0][6]
Ok 'embedded newline' ($r.rows[1][6] -eq "multi`r`nline")
Ok 'empty -> NULL' ($null -eq $r.rows[1][2] -and $null -eq $r.rows[2][3])
Ok 'leading zeros stay text' ($r.rows[0][5] -eq '007')
Ok 'BOM stripped' ($r.cols[0] -eq 'id')
Write-Text "$work/semi.csv" "a;b`n1;x`n2;y`n"
Ok 'semicolon detected' ((J (Rows "SELECT b FROM read_csv('$work/semi.csv') ORDER BY a")) -eq '[["x"],["y"]]')
Write-Text "$work/tab.tsv" "a`tb`n1`t2.5`n"
Ok 'tab detected' ((One "SELECT b FROM read_csv('$work/tab.tsv')") -eq 2.5)
Write-Text "$work/bad.csv" "a,b`n1,""unclosed`n"
Ok 'malformed CSV -> CSV_INVALID_QUOTE' ((ErrCode "SELECT * FROM read_csv('$work/bad.csv')") -eq 'CSV_INVALID_QUOTE')
# A late value that breaks the sampled type widens the column (no data lost).
$sb = New-Object Text.StringBuilder; [void]$sb.Append("k,v`n"); for ($i = 0; $i -lt 30000; $i++) { [void]$sb.Append("$i,$i`n") }; [void]$sb.Append("30000,oops`n")
Write-Text "$work/widen.csv" $sb.ToString()
$r = Q "SELECT count(*) n, max(v) FILTER (WHERE k = 30000) last FROM read_csv('$work/widen.csv')"
Ok 'late bad value widens to VARCHAR' ($r.rows[0][0] -eq 30001 -and $r.rows[0][1] -eq 'oops') (J $r.rows)

Write-Host "`n== Expressions"
Ok 'CASE / IN / BETWEEN' ((J (Rows "SELECT CASE WHEN range IN (1,3) THEN 'odd' WHEN range BETWEEN 2 AND 2 THEN 'two' ELSE 'other' END FROM range(4)")) -eq '[["other"],["odd"],["two"],["odd"]]')
Ok 'LIKE / ILIKE' ((J (Rows "SELECT 'Hello' LIKE 'H%o', 'Hello' ILIKE 'h_llo', 'x' NOT LIKE 'x'")) -eq '[[true,true,false]]')
Ok 'NULL logic' ((J (Rows "SELECT NULL AND false, NULL OR true, NULL = 1, coalesce(NULL, 2), NULL IS NULL")) -eq '[[false,true,null,2,true]]')
Ok 'TRY_CAST bad -> NULL' ((J (Rows "SELECT TRY_CAST('abc' AS INTEGER), TRY_CAST('42' AS INTEGER), CAST(3.7 AS INTEGER)")) -eq '[[null,42,4]]')
Ok 'CAST bad -> error' ((ErrCode "SELECT CAST('abc' AS INTEGER)") -eq 'CAST_FAILED')
Ok 'date functions' ((J (Rows "SELECT year(DATE '2024-03-15'), month(DATE '2024-03-15'), date_trunc('month', DATE '2024-03-15'), DATE '2024-03-15' + 1, strftime(DATE '2024-03-15', '%Y/%m')")) -eq '[[2024,3,"2024-03-01","2024-03-16","2024/03"]]')
Ok 'string functions' ((J (Rows "SELECT upper('ab'), length('abc'), substr('hello', 2, 3), replace('aXb','X','-'), split_part('a,b,c', ',', 2), trim('  x ')")) -eq '[["AB",3,"ell","a-b","b","x"]]')
Ok 'integer division / modulo' ((J (Rows "SELECT 7 // 2, 7 % 3, 1 / 0")) -eq '[[3,1,null]]')
Ok 'unknown column message' ((ErrCode "SELECT nope FROM range(1)") -eq 'COLUMN_NOT_FOUND')
Ok 'syntax error code' ((ErrCode "SELEC 1") -eq 'SQL_SYNTAX')

Write-Host "`n== Aggregates"
$r = Rows "SELECT count(*), count(DISTINCT range % 7), sum(range), avg(range), min(range), max(range), median(range), string_agg(CAST(range AS VARCHAR), '-') FILTER (WHERE range < 3), stddev_samp(range) FROM range(10)"
Ok 'aggregate set' ((J $r) -eq '[[10,7,45,4.5,0,9,4.5,"0-1-2",3.0276503540974917]]') (J $r)
Ok 'count(DISTINCT (a, b))' ((One "SELECT count(DISTINCT (range % 2, range % 3)) FROM range(100)") -eq 6)
Ok 'HAVING + ORDER BY alias' ((J (Rows "SELECT range % 3 g, count(*) n FROM range(10) GROUP BY g HAVING count(*) > 3 ORDER BY n DESC")) -eq '[[0,4]]')
Ok 'min/max text' ((J (Rows "SELECT min(x), max(x) FROM (SELECT 'b' x UNION ALL SELECT 'a' UNION ALL SELECT 'c')")) -eq '[["a","c"]]')
Ok 'empty input count' ((One "SELECT count(*) FROM range(0)") -eq 0)
Ok 'multi-column keys with NULLs' ((J (Rows "SELECT a, b, count(*) FROM (SELECT CASE WHEN range % 3 = 0 THEN NULL ELSE range % 2 END a, 'k' || (range % 2) b FROM range(12)) GROUP BY ALL ORDER BY a NULLS FIRST, b")) -eq '[[null,"k0",2],[null,"k1",2],[0,"k0",4],[1,"k1",4]]')
Ok 'multi-column keys beyond packed codes' ((One "SELECT count(*) FROM (SELECT range, range % 2, 'x' FROM range(1100000) GROUP BY ALL)") -eq 1100000)
Ok 'count distinct text + ints' ((J (Rows "SELECT count(DISTINCT 'v' || (range % 37)), count(DISTINCT range % 41) FROM range(5000)")) -eq '[[37,41]]')

Write-Host "`n== Joins"
$jv = V @{ l = "SELECT range id, range * 10 v FROM range(5)"; r = "SELECT range + 2 id, 'r' || range w FROM range(5)" }
Ok 'inner USING' ((J (Rows "SELECT * FROM l JOIN r USING (id) ORDER BY id" $jv)) -eq '[[2,20,"r0"],[3,30,"r1"],[4,40,"r2"]]')
Ok 'left join' ((RowCount "SELECT * FROM l LEFT JOIN r USING (id)" $jv) -eq 5)
Ok 'right join' ((J (Rows "SELECT id, v, w FROM l RIGHT JOIN r USING (id) ORDER BY id" $jv)) -eq '[[2,20,"r0"],[3,30,"r1"],[4,40,"r2"],[5,null,"r3"],[6,null,"r4"]]')
Ok 'full join' ((RowCount "SELECT * FROM l FULL JOIN r USING (id)" $jv) -eq 7)
Ok 'ON with residual' ((J (Rows "SELECT l.id, r.w FROM l JOIN r ON l.id = r.id AND r.w <> 'r1' ORDER BY 1" $jv)) -eq '[[2,"r0"],[4,"r2"]]')
Ok 'cross join' ((One "SELECT count(*) FROM l, r" $jv) -eq 25)

Write-Host "`n== Window functions"
Ok 'rank / dense_rank / lag' ((J (Rows "SELECT x, rank() OVER (ORDER BY x), dense_rank() OVER (ORDER BY x), lag(x) OVER (ORDER BY x) FROM (SELECT range // 2 x FROM range(4)) ORDER BY 1, 2")) -eq '[[0,1,1,null],[0,1,1,0],[1,3,2,0],[1,3,2,1]]')
Ok 'running sum per partition' ((J (Rows "SELECT range % 2 p, range, sum(range) OVER (PARTITION BY range % 2 ORDER BY range) FROM range(6) ORDER BY 1, 2")) -eq '[[0,0,0],[0,2,2],[0,4,6],[1,1,1],[1,3,4],[1,5,9]]')

Write-Host "`n== Parquet round trip (all types, nulls, codecs)"
$all = "SELECT range id, CAST(range AS INTEGER) i32, CAST(range % 100 AS SMALLINT) i16, range * 1.5 dbl, CAST(range * 1.25 AS DECIMAL(18,2)) dec, CAST(range AS DECIMAL(38,6)) dec38, " +
       "'s' || (range % 50) txt, CASE WHEN range % 3 = 0 THEN NULL ELSE 'v' || range END maybe, range % 2 = 0 flag, " +
       "DATE '2020-01-01' + range dt, CAST('2024-05-06 07:08:09.123456' AS TIMESTAMP) ts FROM range(250000)"
$ref = Q ($all + " ORDER BY id LIMIT 20")
foreach ($c in 0, 1, 2) {
    $m = WriteDs $all "$work/types_$c" $none $c
    $back = Q "SELECT * FROM read_parquet('$work/types_$c') ORDER BY id LIMIT 20"
    Ok "codec ${c}: rows" ($m['rowCount'] -eq 250000) $m['rowCount']
    Ok "codec ${c}: types" (($back.types -join ',') -eq ($ref.types -join ',')) ($back.types -join ',')
    Ok "codec ${c}: values" ((J $back.rows) -eq (J $ref.rows)) ((J $back.rows[1]) + ' vs ' + (J $ref.rows[1]))
}
$m = WriteDs $all "$work/types_1"
Ok 'version increments on rewrite' ($m['version'] -eq 2) $m['version']
Ok 'row groups -> several units' ((One "SELECT count(*) FROM read_parquet('$work/types_1') WHERE flag") -eq 125000)
Ok 'nulls survive' ((One "SELECT count(*) FROM read_parquet('$work/types_1') WHERE maybe IS NULL") -eq 83334)

Write-Host "`n== Snappy codec"
$rnd = New-Object Random 7
foreach ($kind in 'random', 'repeats', 'empty') {
    $n = if ($kind -eq 'empty') { 0 } else { 300000 }
    $b = New-Object byte[] $n
    if ($kind -eq 'random') { $rnd.NextBytes($b) } else { for ($i = 0; $i -lt $n; $i++) { $b[$i] = [byte](($i / 7) % 13) } }
    $c = [NativeDataEngine.SnappyCodec]::Compress($b, $n)
    $d = [NativeDataEngine.SnappyCodec]::Decompress($c, 0, $c.Length, $n)
    Ok "snappy $kind ($n -> $($c.Length))" ([Linq.Enumerable]::SequenceEqual([byte[]]$b, [byte[]]$d))
}

Write-Host "`n== Determinism across worker counts"
$det = "SELECT txt, count(*) n, sum(dbl) s, avg(dec) a, count(DISTINCT dt) d FROM read_parquet('$work/types_1') GROUP BY txt ORDER BY txt"
$base = J (Rows $det $none 1)
foreach ($w in 2, 4, [Environment]::ProcessorCount) { Ok "workers=$w same answer" ((J (Rows $det $none $w)) -eq $base) }
$j1 = J (Rows "SELECT a.txt, count(*) FROM read_parquet('$work/types_1') a JOIN (SELECT DISTINCT txt FROM read_parquet('$work/types_1')) b USING (txt) GROUP BY 1 ORDER BY 1" $none 1)
Ok 'join determinism' ($j1 -eq (J (Rows "SELECT a.txt, count(*) FROM read_parquet('$work/types_1') a JOIN (SELECT DISTINCT txt FROM read_parquet('$work/types_1')) b USING (txt) GROUP BY 1 ORDER BY 1" $none 8)))

# Join whose build side is itself parallel, at the full worker count (regression: nested pool waits deadlocked).
$jq = "SELECT count(*) FROM read_parquet('$work/types_1') a JOIN (SELECT txt, max(dbl) m FROM read_parquet('$work/types_1') GROUP BY txt) b USING (txt)"
$t = [Diagnostics.Stopwatch]::StartNew(); $n = One $jq
Ok "join at full worker count finishes ($($t.ElapsedMilliseconds) ms)" ($n -eq 250000)

Write-Host "`n== Round trips"
$csvSql = "SELECT * FROM read_csv('$work/tricky.csv')"
WriteDs $csvSql "$work/rt_csv" | Out-Null
$j = New-Object NativeDataEngine.Job('export', 't')
$x = $e.Export($j, "SELECT * FROM read_parquet('$work/rt_csv') ORDER BY id", $none, "$work/rt_out.csv", 'csv', $null)
Ok 'CSV -> Parquet -> CSV' ((J (Rows "SELECT * FROM read_csv('$work/rt_out.csv') ORDER BY id")) -eq (J (Rows "$csvSql ORDER BY id")))
$x = $e.Export($j, "SELECT id, txt, dbl, flag, dt, maybe FROM read_parquet('$work/types_1') WHERE id < 1000", $none, "$work/rt.sqlite", 'sqlite', 'things')
Ok 'export SQLite' ($x['rows'] -eq 1000)
Ok 'SQLite tables listed' ((($e.OpenSource("$work/rt.sqlite", $null))['tables'] -join ',') -eq 'things')
WriteDs "SELECT * FROM read_sqlite('$work/rt.sqlite', 'things')" "$work/rt_sqlite" | Out-Null
Ok 'SQLite -> Parquet' ((One "SELECT count(*) FROM read_parquet('$work/rt_sqlite') WHERE maybe IS NULL") -eq 334)
$x = $e.Export($j, "SELECT * FROM read_parquet('$work/rt_sqlite')", $none, "$work/rt2.sqlite", 'sqlite', 'things')
Ok 'Parquet -> SQLite again' ((J (Rows "SELECT sum(id), count(txt), sum(dbl) FROM read_sqlite('$work/rt2.sqlite', 'things')")) -eq (J (Rows "SELECT sum(id), count(txt), sum(dbl) FROM read_parquet('$work/types_1') WHERE id < 1000")))
$x = $e.Export($j, "SELECT * FROM read_parquet('$work/types_1')", $none, "$work/single.parquet", 'parquet', $null)
Ok 'single-file Parquet export' ((One "SELECT count(*) FROM read_parquet('$work/single.parquet')") -eq 250000)

Write-Host "`n== Failures keep the last good dataset"
$before = One "SELECT count(*) FROM read_parquet('$work/types_2')"
$code = try { WriteDs "SELECT CAST(CASE WHEN range = 200000 THEN 'x' ELSE '1' END AS INTEGER) v FROM range(300000)" "$work/types_2" | Out-Null; 'none' } catch { (Inner $_.Exception).Code }
Ok 'failed write raises CAST_FAILED' ($code -eq 'CAST_FAILED') $code
Ok 'previous dataset intact' ((One "SELECT count(*) FROM read_parquet('$work/types_2')") -eq $before)
Ok 'no temp folders left' (@(Get-ChildItem $workFull -Directory | Where-Object Name -like '*.tmp-*').Count -eq 0)
$job = $e.StartWrite("SELECT range a, range * 2 b FROM range(400000000)", $none, "$work/types_2", $null, 1, 0)
Start-Sleep -Milliseconds 700; [void]$e.Jobs.Cancel($job.Id)
[void]$job.WaitDone(10000)
Ok 'cancelled job state' ($job.State -eq 'cancelled') ($job.State + ' ' + $(if ($job.Error) { $job.Error.Code + ' ' + $job.Error.Detail.Substring(0, [Math]::Min(600, $job.Error.Detail.Length)) }))
Ok 'dataset intact after cancel' ((One "SELECT count(*) FROM read_parquet('$work/types_2')") -eq $before)
[IO.File]::WriteAllBytes((Join-Path $workFull 'corrupt.parquet'), [byte[]](80, 65, 82, 49, 1, 2, 3, 4, 5, 6, 7, 8, 80, 65, 82, 49))
Ok 'corrupt Parquet -> PARQUET_CORRUPT' ((ErrCode "SELECT * FROM read_parquet('$work/corrupt.parquet')") -eq 'PARQUET_CORRUPT')
# A file that claims ZSTD compression.
$fl = New-Object 'System.Collections.Generic.List[NativeDataEngine.Field]'
$fl.Add((New-Object NativeDataEngine.Field('a', [NativeDataEngine.DataType]::BigInt)))
$sch = New-Object NativeDataEngine.Schema -ArgumentList (,$fl)
$col = New-Object NativeDataEngine.Column([NativeDataEngine.DataType]::BigInt, 3)
$bt = New-Object NativeDataEngine.Batch($sch, [NativeDataEngine.Column[]]@($col), 3)
$w = New-Object NativeDataEngine.ParquetFileWriter((Join-Path $workFull 'zstd.parquet'), $sch, 6)
$w.Append([NativeDataEngine.ParquetFileWriter]::Encode($bt, 0)); $w.Close()
Ok 'ZSTD Parquet rejected clearly' ((ErrCode "SELECT * FROM read_parquet('$work/zstd.parquet')") -eq 'PARQUET_UNSUPPORTED_CODEC')
Ok 'path outside project rejected' ((ErrCode "SELECT * FROM read_csv('../x.csv')") -eq 'PATH_FORBIDDEN')
Ok 'dot folder rejected' ((ErrCode "SELECT * FROM read_csv('.server/settings.json')") -eq 'PATH_FORBIDDEN')
Ok 'non-data external file rejected' ((ErrCode "SELECT * FROM read_csv('C:\Windows\win.ini')") -eq 'PATH_FORBIDDEN')

Write-Host "`n== Pipeline DAG"
$spec = @{ datasets = @{ base = "$work/types_1" }; version = 3; nodes = @(
    @{ id = 'n1'; name = 'f'; sql = 'SELECT id, txt, dbl FROM base WHERE flag'; output = $false },
    @{ id = 'n2'; name = 'g'; sql = 'SELECT txt, sum(dbl) s FROM f GROUP BY txt'; output = $true; dest = "$work/out_g" },
    @{ id = 'n3'; name = 'h'; sql = 'SELECT count(*) n FROM f'; output = $true; dest = "$work/out_h" }) }
$specD = [NativeDataEngine.Json]::Parse(($spec | ConvertTo-Json -Depth 6))
$jp = New-Object NativeDataEngine.Job('pipeline', 't')
$res = $e.RunPipeline($jp, $specD)
Ok 'pipeline outputs written' ($res['outputs'].Count -eq 2 -and (One "SELECT n FROM read_parquet('$work/out_h')") -eq 125000)
Ok 'topological order' (($res['order'] -join ',') -eq 'f,g,h') ($res['order'] -join ',')
$m = [NativeDataEngine.Datasets]::Manifest((Join-Path $workFull 'out_g'))
Ok 'lineage recorded' ($m['lineage']['pipelineStep'] -eq 'g' -and $m['lineage']['upstream'][0]['dataset'] -eq 'base')
$spec.changed = @('nothing'); $res = $e.RunPipeline($jp, [NativeDataEngine.Json]::Parse(($spec | ConvertTo-Json -Depth 6)))
Ok 'update skips unaffected outputs' ($res['outputs'].Count -eq 0 -and $res['skipped'].Count -eq 2)
$spec.changed = @('base'); $res = $e.RunPipeline($jp, [NativeDataEngine.Json]::Parse(($spec | ConvertTo-Json -Depth 6)))
Ok 'update reruns affected outputs' ($res['outputs'].Count -eq 2)
$spec.nodes = @(@{ id = 'a'; name = 'a'; sql = 'SELECT * FROM b'; output = $true; dest = "$work/x" }, @{ id = 'b'; name = 'b'; sql = 'SELECT * FROM a'; output = $false })
$spec.Remove('changed')
$code = try { $e.RunPipeline($jp, [NativeDataEngine.Json]::Parse(($spec | ConvertTo-Json -Depth 6))) | Out-Null; 'none' } catch { (Inner $_.Exception).Code }
Ok 'cycle detected' ($code -eq 'PIPELINE_CYCLE') $code

Write-Host "`n== Memory guard"
$o = New-Object NativeDataEngine.EngineOptions; $o.RootPath = $root; $o.MemoryLimitBytes = 64MB
$small = New-Object NativeDataEngine.DataEngine($o)
$code = try { $small.Query("SELECT range, 'pad-' || range p FROM range(6000000) ORDER BY p DESC", $none, 10, 0, [Threading.CancellationToken]::None) | Out-Null; 'none' } catch { (Inner $_.Exception).Code }
Ok 'sort over budget -> QUERY_OUT_OF_MEMORY' ($code -eq 'QUERY_OUT_OF_MEMORY') $code
$small.Dispose()

if ($Big) {
    Write-Host "`n== Large CSV, bounded memory"
    $bigCsv = Join-Path $workFull 'big.csv'
    $sw = New-Object IO.StreamWriter($bigCsv, $false, (New-Object Text.UTF8Encoding($false)), 1MB)
    $sw.WriteLine('id,customer,region,amount,day')
    $regions = 'north', 'south', 'east', 'west'
    for ($i = 0; $i -lt 4000000; $i++) { $sw.Write($i); $sw.Write(',c'); $sw.Write($i % 50000); $sw.Write(','); $sw.Write($regions[$i % 4]); $sw.Write(','); $sw.Write(($i % 1000) / 4); $sw.WriteLine(',2024-01-01') }
    $sw.Close()
    $size = (Get-Item $bigCsv).Length
    [GC]::Collect(); $p0 = [Diagnostics.Process]::GetCurrentProcess(); $p0.Refresh(); $before = $p0.PrivateMemorySize64
    $peak = 0; $j = $e.StartWrite("SELECT * FROM read_csv('$work/big.csv')", $none, "$work/big", $null, 1, 0)
    $sw2 = [Diagnostics.Stopwatch]::StartNew()
    while (-not $j.WaitDone(50)) { $p0.Refresh(); $peak = [Math]::Max($peak, $p0.PrivateMemorySize64) }
    Ok "big CSV import ($([int]($size / 1MB)) MB, $($sw2.ElapsedMilliseconds) ms)" ($j.State -eq 'done') $j.State
    Ok "memory bounded (grew $([int](($peak - $before) / 1MB)) MB for a $([int]($size / 1MB)) MB file)" (($peak - $before) -lt [Math]::Max(600MB, $size))
    Ok 'big rows' ((One "SELECT count(*) FROM read_parquet('$work/big')") -eq 4000000)
    $t = [Diagnostics.Stopwatch]::StartNew(); $g = RowCount "SELECT region, count(*), sum(amount) FROM read_parquet('$work/big') GROUP BY 1 ORDER BY 1"
    Ok "big group-by ($($t.ElapsedMilliseconds) ms)" ($g -eq 4)
}

$e.Dispose()
Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
if ($script:fail) { Write-Host ("Failed: " + ($script:failed -join '; ')) -ForegroundColor Red; exit 1 }
