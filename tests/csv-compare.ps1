# Old vs new CSV reader: writes tricky CSV files, reads them with the engine at -OldRef (git worktree) and with this
# checkout (tests\csv-diff.ps1), and compares every value. Decimal values may differ only in the last bit where the old
# engine used .NET Framework's double.Parse (not always correctly rounded); those lines are listed separately.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\csv-compare.ps1 [-OldRef 7594849]
# ASCII only (Windows PowerShell 5.1).
param([string]$OldRef = '7594849')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:TEMP ('dn-csvdiff-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Force $dir | Out-Null
$q = '"'
$files = @{
  'a_quotes.csv' = "id,name,note`n1,${q}Smith, John${q},${q}said ${q}${q}hi${q}${q}${q}`n2,${q}multi`nline${q},x`n3,,${q}${q}`n4,plain,${q}a,b,c${q}`n"
  'b_crlf_bom.csv' = [string][char]0xFEFF + "k,v`r`n1,10`r`n`r`n2,20`r`n3,30"
  'c_numbers.csv' = "i,d,z,s`n 12 ,0.39266239,007,+5`n-0,65766.406207, 1.5e3,x`n+5,273.37467264,0,-7`n9223372036854775807,1234567890.12345678,1,8`n,,,`n"
  'd_dates.csv' = "d,t,dd`n2024-01-31,2024-01-31 10:20:30,2024-1-5`n1999-12-31,2024-02-29T23:59:59,2024/02/03`n2000-02-29,2024-03-01 00:00:00.123456,2024-12-31`n"
  'e_semicolon.csv' = "a;b;c`n1;x;2.5`n2;y;3.5`n"
  'f_noheader.csv' = "1,2,3`n4,5,6`n7,8,9`n"
  'g_bools.csv' = "flag,n`ntrue,1`nfalse,2`nyes,3`nno,4`n"
  'h_tabs.tsv.csv' = "a`tb`n1`t${q}x`ty${q}`n2`tz`n"
}
$wide = New-Object Text.StringBuilder; [void]$wide.Append("id,val,txt`n")
for ($i = 0; $i -lt 30000; $i++) { [void]$wide.Append("$i,$($i % 97),t$($i % 13)`n") }
[void]$wide.Append("30000,1.25,t1`n30001,abc,t2`n")   # past the 20k-row type sample: val widens Int -> Double -> Varchar
$files['i_widen.csv'] = $wide.ToString()
$big = New-Object Text.StringBuilder; [void]$big.Append("id,price,cat,day`n")
for ($i = 0; $i -lt 800000; $i++) { [void]$big.Append("$i,$(($i * 7) % 10000 / 100.0),C$($i % 50),2024-$((($i % 12) + 1).ToString('00'))-$((($i % 28) + 1).ToString('00'))`n") }
$files['j_big.csv'] = $big.ToString()
$win = New-Object Text.StringBuilder; [void]$win.Append("id,g,h,v,s`n")
for ($i = 0; $i -lt 30000; $i++) { $g = if ($i % 41 -eq 0) { '' } else { "G$($i % 37)" }; $v = if ($i % 23 -eq 0) { '' } else { "$(($i * 13) % 50)" }; [void]$win.Append("$i,$g,$($i % 3),$v,s$(($i * 7) % 11)`n") }
$files['k_window.csv'] = $win.ToString()
foreach ($k in $files.Keys) { [IO.File]::WriteAllText((Join-Path $dir $k), $files[$k], (New-Object Text.UTF8Encoding($false))) }

$old = Join-Path $env:TEMP "dn-old-engine-$OldRef"
$made = $false
if (-not (Test-Path (Join-Path $old 'engine'))) { git -C $root worktree add --detach $old $OldRef | Out-Null; $made = $true }
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$a = & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tests\csv-diff.ps1') -Root $old -Dir $dir
$b = & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tests\csv-diff.ps1') -Root $root -Dir $dir
if ($made) { git -C $root worktree remove --force $old 2>$null }
Remove-Item -Recurse -Force $dir
$same = 0; $ulp = 0; $diff = 0
for ($i = 0; $i -lt [Math]::Max($a.Count, $b.Count); $i++) {
  if ($a[$i] -ceq $b[$i]) { $same++; continue }
  # Same text everywhere except bits= of decimals one apart: a last-bit rounding fix, not a change of value.
  $sa = [regex]::Replace([string]$a[$i], ' bits=-?\d+', ''); $sb = [regex]::Replace([string]$b[$i], ' bits=-?\d+', '')
  $ba = @([regex]::Matches([string]$a[$i], 'bits=(-?\d+)') | ForEach-Object { [long]$_.Groups[1].Value })
  $bb = @([regex]::Matches([string]$b[$i], 'bits=(-?\d+)') | ForEach-Object { [long]$_.Groups[1].Value })
  $close = $ba.Count -eq $bb.Count -and $ba.Count -gt 0
  for ($k = 0; $close -and $k -lt $ba.Count; $k++) { if ([Math]::Abs($ba[$k] - $bb[$k]) -gt 1) { $close = $false } }
  $textSame = ([regex]::Replace($sa, '\d+\.\d+', 'N')) -eq ([regex]::Replace($sb, '\d+\.\d+', 'N'))
  if ($close -and $textSame) { $ulp++; if ($ulp -le 5) { Write-Host "  last bit: old $($a[$i])"; Write-Host "            new $($b[$i])" } }
  else { $diff++; if ($diff -le 20) { Write-Host "  DIFF old: $($a[$i])" -ForegroundColor Red; Write-Host "       new: $($b[$i])" -ForegroundColor Red } }
}
Write-Host "Lines: $($a.Count) old / $($b.Count) new; identical $same, last-bit decimal fixes $ulp, different $diff"
if ($diff -gt 0) { exit 1 }
