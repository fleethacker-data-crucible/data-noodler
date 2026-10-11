# Spill to disk: GROUP BY, sorts, windows and joins run with a tiny memory budget (default 40 MB, or the first
# argument in MB) must spill and give the same answers as with the normal budget. ASCII only (PowerShell 5.1).
param([int]$LimitMb = 40)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '.server\engine-loader.ps1')
Write-Host ('Engine: ' + (Load-DataEngine -Root $root))
$big = New-DataEngine -Root $root -MaxWorkers 8
$small = New-DataEngine -Root $root -MaxWorkers 8 -MemoryLimitBytes ([long]$LimitMb * 1MB)
$none = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
$ct = [Threading.CancellationToken]::None
function Txt($e, $sql) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = $e.Query($sql, $none, 1000, 0, $ct)
  $sb = New-Object Text.StringBuilder
  foreach ($b in $r.Batches) { for ($i = 0; $i -lt $b.Rows; $i++) { for ($c = 0; $c -lt $b.Cols.Length; $c++) { [void]$sb.Append([NativeDataEngine.Values]::Text($b.Cols[$c], $i)).Append('|') }; [void]$sb.Append(';') } }
  return @{ t = $sb.ToString(); ms = $sw.ElapsedMilliseconds }
}
$T = "(SELECT i AS id, i % 1500000 AS k, 'name-' || CAST(i * 7 % 2000003 AS VARCHAR) AS s, (i * 13) % 1000 / 10.0 AS v FROM range(3000000) t(i))"
$R = "(SELECT i AS k2, 'right-' || CAST(i AS VARCHAR) AS rs, i % 7 AS g FROM range(2000000) t(i))"
$qs = @(
  @('group by 1.5M keys', "SELECT count(*), sum(c), round(sum(sv), 2), max(mx) FROM (SELECT k, count(*) AS c, sum(v) AS sv, max(s) AS mx FROM $T x GROUP BY k) q"),
  @('full sort (last rows)', "SELECT id, s, v FROM (SELECT * FROM $T x ORDER BY s DESC, id) q LIMIT 5 OFFSET 2999990"),
  @('sort with nulls', "SELECT id FROM (SELECT id, CASE WHEN id % 5 = 0 THEN NULL ELSE v END AS w FROM $T x ORDER BY w NULLS FIRST, id DESC) q LIMIT 3 OFFSET 1500000"),
  @('window rank', "SELECT count(*), sum(r), max(r) FROM (SELECT row_number() OVER (PARTITION BY k ORDER BY v DESC, id) AS r FROM $T x) q"),
  @('inner join big', "SELECT count(*), round(sum(x.v), 2), count(DISTINCT y.g), max(y.rs) FROM $T x JOIN $R y ON x.k = y.k2"),
  @('left join big', "SELECT count(*), count(y.rs), sum(x.id) FROM $T x LEFT JOIN $R y ON x.id = y.k2"),
  @('join + group', "SELECT y.g, count(*), round(sum(x.v), 2) FROM $T x JOIN $R y ON x.k = y.k2 GROUP BY y.g ORDER BY y.g")
)
$pass = 0; $fail = 0
foreach ($q in $qs) {
  try { $a = Txt $big $q[1] } catch { Write-Host ("BIG FAIL " + $q[0] + ': ' + $_.Exception.InnerException.Message); continue }
  $c0 = [NativeDataEngine.Spill]::Count
  try { $b = Txt $small $q[1]; $ok = $a.t -eq $b.t } catch { $b = @{ ms = 0 }; $ok = $false; Write-Host ('  small err: ' + $_.Exception.InnerException.Message) }
  if ($ok) { $pass++ } else { $fail++ }
  Write-Host ('{0,-5} {1,-22} memory {2,6} ms   spilled {3,6} ms  spills {4}' -f $(if ($ok) { 'ok' } else { 'FAIL' }), $q[0], $a.ms, $b.ms, ([NativeDataEngine.Spill]::Count - $c0))
  if (-not $ok -and $b.t) { Write-Host ('   big:   ' + $a.t.Substring(0, [Math]::Min(200, $a.t.Length))); Write-Host ('   small: ' + $b.t.Substring(0, [Math]::Min(200, $b.t.Length))) }
}
Write-Host "Passed $pass, failed $fail; reserved after: $($small.Mem.Reserved); spill dirs left: $(@(Get-ChildItem ([NativeDataEngine.DataEngine]::SpillRoot) -ErrorAction SilentlyContinue).Count)"
