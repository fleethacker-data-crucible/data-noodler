# Runs every command from ref-docs/basic-sql-cheatsheet.md and ref-docs/advanced-sql-cheatsheet.md against the
# native engine (plus edge cases) and checks the results. Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\sql-cheatsheet.ps1
# Test data is written to %TEMP% (never into the project). ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).
param([string]$Only = '', [switch]$Show)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '.server\engine-loader.ps1')
Write-Host ('Engine: ' + (Load-DataEngine -Root $root))
$engine = New-DataEngine -Root $root -MaxWorkers 8

# ---------- test data ----------
$dir = Join-Path $env:TEMP ('dn-sqltest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $dir | Out-Null
$data = @{
  employees = @'
id,employee_id,name,employee_name,department,department_id,salary,manager_id,hire_date,phone_number,created_at,manager_name
1,1,John,John,IT,10,80000,,2020-01-15,555-0101,2022-05-01,
2,2,Jane,Jane,IT,10,65000,1,2021-03-01,,2023-02-01,John
3,3,Bob,Bob,HR,20,45000,1,2019-07-10,555-0103,2022-12-31,John
4,4,Alice,Alice,HR,20,55000,3,2022-02-20,,2023-06-15,Bob
5,5,Jackson,Jackson,Finance,30,40000,1,2018-11-05,555-0105,2021-01-01,John
6,6,Emma,Emma,Finance,30,72000,5,2023-05-30,,2024-01-10,Jackson
7,7,Johnson,Johnson,Sales,40,30000,1,2017-09-12,555-0107,2020-03-03,John
'@
  projects = @'
project_id,employee_id,project_name
1,1,Apollo
2,1,Zeus
3,3,Hermes
4,6,Athena
5,9,Orphan
'@
  departments = @'
department_id,department_name
10,Information Technology
20,Human Resources
30,Finance
40,Sales
50,Legal
'@
  customers = @'
customer_id,customer_name
1,Acme
2,Globex
3,Initech
'@
  orders = @'
order_id,customer_id
100,1
101,1
102,3
'@
  products = @'
product_name,price
Widget,10
Gadget,25
Doohickey,40
'@
  competitors_products = @'
price
20
30
'@
  sales = @'
region,product,sales,department_id
East,A,100,10
East,B,200,10
West,A,300,20
West,B,400,30
'@
  sales_data = @'
product,year,revenue
A,2023,10
A,2024,20
B,2023,5
B,2024,7
A,2023,1
'@
  target_table = @'
id,column,column1,column2
1,old1,a,x
2,old2,b,y
'@
  source_table = @'
id,column,column1,column2
2,new2,bb,yy
3,new3,cc,zz
'@
  active_table = @'
id,name,created_at
1,alpha,2022-06-01
2,beta,2023-03-01
3,gamma,2022-12-31
'@
  accounts = @'
account_id,balance
1,500
2,300
'@
  old_data = @'
id,v
1,a
2,b
'@
}
$views = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($k in $data.Keys) {
  $f = Join-Path $dir "$k.csv"
  [IO.File]::WriteAllText($f, ($data[$k].Trim() -replace "`r", '') + "`n")
  $views[$k] = "SELECT * FROM read_csv('" + $f.Replace("'", "''") + "')"
}

# ---------- runner ----------
function Fmt($r) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($b in $r.Batches) {
    for ($i = 0; $i -lt $b.Rows; $i++) {
      $cells = @()
      for ($c = 0; $c -lt $b.Cols.Length; $c++) { $v = [NativeDataEngine.Values]::Text($b.Cols[$c], $i); if ($null -eq $v) { $v = 'NULL' }; $cells += $v }
      $lines.Add(($cells -join '|'))
    }
  }
  return $lines
}
$script:pass = 0; $script:fail = 0; $script:failed = @()
# T name sql expected [-Sorted] [-Cols 'a,b'] [-Error 'CODE'] [-Bare (no datasets)]
$noViews = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
function T([string]$name, [string]$sql, [string]$expect = $null, [switch]$Sorted, [string]$Cols = $null, [string]$Error = $null, [switch]$Bare) {
  if ($Only -and $name -notlike "*$Only*") { return }
  $got = $null; $err = $null; $code = $null; $colsGot = $null
  try {
    $r = $engine.Query($sql, $(if ($Bare) { $noViews } else { $views }), 0, 0, [Threading.CancellationToken]::None)
    $lines = @(Fmt $r)
    if ($Sorted) { $lines = @($lines | Sort-Object) }
    $got = ($lines -join "`n")
    $colsGot = (@($r.Schema.Fields | ForEach-Object { $_.Name }) -join ',')
  } catch {
    $e = $_.Exception; while ($e.InnerException -and -not ($e -is [NativeDataEngine.EngineException])) { $e = $e.InnerException }
    $err = $e.Message; if ($e -is [NativeDataEngine.EngineException]) { $code = $e.Code }
  }
  $ok = $true; $why = ''
  if ($Error) {
    if ($code -ne $Error) { $ok = $false; $why = "expected error $Error, got " + $(if ($err) { "$code : $err" } else { "rows:`n$got" }) }
  } elseif ($err) { $ok = $false; $why = "error $code : $err" }
  else {
    $exp = ($expect.Trim() -replace "`r", '' -split "`n" | ForEach-Object { $_.Trim() })
    if ($Sorted) { $exp = @($exp | Sort-Object) }
    $exp = ($exp -join "`n")
    if ($got -ne $exp) { $ok = $false; $why = "expected:`n$exp`ngot:`n$got" }
    if ($Cols -and $colsGot -ne $Cols) { $ok = $false; $why += "`ncolumns expected $Cols, got $colsGot" }
  }
  if ($ok) { $script:pass++; if ($Show) { Write-Host "ok   $name" -ForegroundColor Green; if ($got) { Write-Host $got } } }
  else { $script:fail++; $script:failed += $name; Write-Host "FAIL $name" -ForegroundColor Red; Write-Host $why }
}

. (Join-Path $PSScriptRoot 'sql-cheatsheet-cases.ps1')

Write-Host ''
Write-Host ("Passed {0}, failed {1}" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
if ($script:fail) { $script:failed | ForEach-Object { Write-Host "  $_" } }
$engine.Dispose()
Remove-Item -Recurse -Force $dir
if ($script:fail) { exit 1 }
