# Pester 5 smoke tests (FleetHacker standard). Run: Invoke-Pester -Path .\tests -Output Detailed
# Static checks only: they read files and never start the tool.
BeforeDiscovery {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $skip = '[\\/](\.git|\.claude|node_modules|temp|vscode-ext-source)[\\/]'
    $script:ScriptFiles = @(Get-ChildItem -Path $script:RepoRoot -Recurse -File -Include *.ps1, *.psm1 |
        Where-Object { $_.FullName -notmatch $skip } |
        ForEach-Object { @{ Name = $_.FullName.Substring($script:RepoRoot.Length + 1); Path = $_.FullName } })
    # Server source files and the loopback bind expected. Fails only on +, *, 0.0.0.0 or a non-loopback bind.
    $script:Servers = @(
        @{ File = 'server\server.ps1'; Pattern = '(IPAddress\]?::Loopback|IPAddress\.Loopback|http://127\.0\.0\.1:|http://localhost:|http://\[::1\]:)'; Skip = $null }
    )
}

Describe 'PowerShell 5.1 parse' {
    It 'parses <Name>' -ForEach $script:ScriptFiles {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
        # TypeNotFound = class defined in another file (load-order dependency), not a syntax error.
        $real = @($errors | Where-Object { $_.ErrorId -ne 'TypeNotFound' } | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })
        $real | Should -BeNullOrEmpty
    }
}

Describe 'Loopback-only bind' -Skip:($script:Servers.Count -eq 0) {
    It '<File> never binds a wildcard address' -ForEach $script:Servers {
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun ($File -replace "\\", [IO.Path]::DirectorySeparatorChar)))
        $text | Should -Not -Match 'https?://(\+|\*|0\.0\.0\.0)[:/]'
        $text | Should -Not -Match 'IPAddress\]?::(Any|IPv6Any)\b'
    }
    It '<File> binds loopback (localhost, 127.0.0.1 or IPAddress.Loopback)' -ForEach $script:Servers {
        if ($Skip) { Set-ItResult -Skipped -Because $Skip; return }
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun ($File -replace "\\", [IO.Path]::DirectorySeparatorChar)))
        $text | Should -Match $Pattern
    }
}

BeforeAll {
    $script:RepoRootRun = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
