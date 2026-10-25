# Pester 5 smoke tests for the port block + self-detection in server\server.ps1.
# Run: Invoke-Pester -Path .\tests -Output Detailed
# These do not start Data Noodler (it opens browser windows and compiles the engine); see the PR for the manual check.
BeforeAll {
    $script:repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:serverPath = Join-Path $repo (Join-Path 'server' 'server.ps1')
    $script:serverText = [IO.File]::ReadAllText($serverPath)
    Import-Module (Join-Path $repo (Join-Path 'server' 'FleetPort.psm1')) -Force
    $tokens = $null; $errors = $null
    $script:ast = [System.Management.Automation.Language.Parser]::ParseFile($serverPath, [ref]$tokens, [ref]$errors)
    function Get-ServerFunction([string]$Name) {
        $script:ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true).Extent.Text
    }
}

Describe 'Data Noodler port block and self-detection' {
    It 'registry puts data-noodler on 8079-8081, policy reuse' {
        $b = Get-FleetPortBlock -Tool 'data-noodler' -RegistryPath (Join-Path $repo (Join-Path 'server' 'FleetPorts.psd1'))
        $b.Start | Should -Be 8079
        $b.Size | Should -Be 3
        $b.Policy | Should -Be 'reuse'
    }

    It 'Get-RandomPort picks only from 30000-46999' {
        . ([scriptblock]::Create((Get-ServerFunction 'Get-RandomPort')))
        function Test-PortFree([int]$p) { $null = $p; $true }
        $settings = @{ port = 47823 }
        $null = $settings
        $ports = 1..300 | ForEach-Object { Get-RandomPort }
        ($ports | Measure-Object -Minimum).Minimum | Should -BeGreaterOrEqual 30000
        ($ports | Measure-Object -Maximum).Maximum | Should -BeLessOrEqual 46999
    }

    It 'no longer stops a previous instance by matching its command line' {
        $serverText | Should -Not -Match "CommandLine\s+-like\s+'\*server\.ps1\*'"
        $serverText | Should -Match 'Resolve-FleetPort\s+-Tool\s+''data-noodler'''
    }

    It 'answers /__fleethacker/ before any panel or site handler' {
        $i = $serverText.IndexOf('Invoke-FleetIdEndpoint -Context $ctx')
        $i | Should -BeGreaterThan 0
        $i | Should -BeLessThan $serverText.IndexOf('Handle-Ui $req $res $rel')
        $serverText | Should -Match "if \(\`$fleet -eq 'shutdown'\) \{[^}]*\`$script:running = \`$false"
    }

    It 'the panel listener uses the port chosen from the block' {
        $serverText.IndexOf('$uiPort = $slot.Port') | Should -BeLessThan $serverText.IndexOf('$listener.Prefixes.Add("http://localhost:$uiPort/")')
    }
}
