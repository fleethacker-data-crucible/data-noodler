$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '.server\engine-loader.ps1')
Load-DataEngine -Root $root | Out-Host
$e = New-DataEngine -Root $root
$v = New-Object 'System.Collections.Generic.Dictionary[string,string]'
function Q($sql) { try { $r = $e.Query($sql, $v, 50, 0, [Threading.CancellationToken]::None); [NativeDataEngine.EngineApi]::ResultJson($r) } catch { "ERR: " + $_.Exception.InnerException.Message } }
Q "SELECT 1 + 2 AS x, 'a' || 'b' s, CAST('2024-01-05' AS DATE) d, 7 / 2 h"
Q "SELECT count(*), sum(range), avg(range), min(range), max(range) FROM range(1000000)"
Q "SELECT range % 3 k, count(*) c FROM range(10) GROUP BY ALL ORDER BY ALL"
Q "SELECT range r, row_number() OVER (ORDER BY range DESC) rn, sum(range) OVER (ORDER BY range) rs FROM range(5)"
Q "WITH a AS (SELECT range id FROM range(5)), b AS (SELECT range id, range*10 v FROM range(3)) SELECT * FROM a LEFT JOIN b USING (id) ORDER BY id"
$e.Dispose()
