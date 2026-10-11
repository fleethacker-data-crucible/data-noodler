# CSV reader regression: tricky CSV files read by the engine in -Root; prints every value with its type.
# tests\csv-compare.ps1 runs it against the old and the new engine and compares the output line by line.
# ASCII only (Windows PowerShell 5.1).
param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
. (Join-Path $Root '.server\engine-loader.ps1')
[void](Load-DataEngine -Root $Root)
$e = New-DataEngine -Root $Root -MaxWorkers 8
$none = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$out = New-Object System.Collections.Generic.List[string]
foreach ($f in Get-ChildItem $Dir -Filter *.csv | Sort-Object Name) {
  $p = $f.FullName.Replace("'", "''")
  $sqls = "SELECT * FROM read_csv('$p')", "SELECT count(*) FROM read_csv('$p')"
  # Big files (parallel byte ranges): checksums instead of every row.
  if ($f.Name -like '*window*') {
    $W = "read_csv('$p')"
    $sqls = @(
      "SELECT id, g, v, row_number() OVER (PARTITION BY g ORDER BY v DESC) AS rn, rank() OVER (PARTITION BY g ORDER BY v) AS rk, dense_rank() OVER (PARTITION BY g ORDER BY v) AS dr FROM $W ORDER BY id",
      "SELECT id, lag(v) OVER (PARTITION BY g ORDER BY id) AS l1, lead(v, 2, -1) OVER (PARTITION BY g ORDER BY id) AS l2, lag(s, 1, 'none') OVER (PARTITION BY g ORDER BY id) AS ls FROM $W ORDER BY id",
      "SELECT id, sum(v) OVER (PARTITION BY g ORDER BY v) AS rs, avg(v) OVER (PARTITION BY g) AS av, count(*) OVER (PARTITION BY g ORDER BY v) AS c, min(s) OVER (PARTITION BY g) AS mn, max(v) OVER (PARTITION BY g ORDER BY id) AS mx FROM $W ORDER BY id",
      "SELECT id, first_value(v) OVER (PARTITION BY g, h ORDER BY v, id) AS fv, last_value(s) OVER (PARTITION BY g, h ORDER BY v) AS lv, ntile(4) OVER (PARTITION BY h ORDER BY v) AS nt, percent_rank() OVER (PARTITION BY g ORDER BY v) AS pr, cume_dist() OVER (PARTITION BY g ORDER BY v) AS cd FROM $W ORDER BY id",
      "SELECT id, row_number() OVER (ORDER BY v, id) AS rn, sum(v) OVER () AS tot FROM $W ORDER BY id"
    )
  }
  if ($f.Name -like '*big*') { $sqls = "SELECT count(*), sum(id), sum(price), min(price), max(price), count(DISTINCT cat), min(day), max(day), sum(length(cat)) FROM read_csv('$p')", "SELECT cat, count(*), sum(price) FROM read_csv('$p') GROUP BY cat ORDER BY cat" }
  foreach ($sql in $sqls) {
    try {
      $r = $e.Query($sql, $none, 0, 0, [Threading.CancellationToken]::None)
      $out.Add("## $($f.Name) | $(@($r.Schema.Fields | ForEach-Object { $_.Name + ':' + $_.Type.Name }) -join ',')")
      foreach ($b in $r.Batches) { for ($i = 0; $i -lt $b.Rows; $i++) { $cells = @(); for ($c = 0; $c -lt $b.Cols.Length; $c++) { $col = $b.Cols[$c]; $v = [NativeDataEngine.Values]::Text($col, $i); if ($null -eq $v) { $v = '<null>' } elseif ($col.F -ne $null) { $v += ' bits=' + [BitConverter]::DoubleToInt64Bits($col.F[$i]) }; $cells += '[' + $v + ']' }; $out.Add(($cells -join ' ')) } }
    } catch { $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }; $out.Add("## $($f.Name) ERROR $($x.Message)") }
  }
}
$e.Dispose()
$out
