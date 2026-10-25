# Runs the Node checks for the project classification migration (tests/classification-migration.test.mjs).
# Skipped when node.exe is not on PATH (workstations have no Node; CI and dev machines run it).
Describe 'Project classification migration (Node)' {
    It 'maps legacy values and never defaults unknown values to Public' {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { Set-ItResult -Skipped -Because 'node is not on PATH'; return }
        $test = Join-Path $PSScriptRoot 'classification-migration.test.mjs'
        $out = & $node.Source --test $test 2>&1 | Out-String
        $LASTEXITCODE | Should -Be 0 -Because $out
    }
}
