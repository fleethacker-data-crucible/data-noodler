# Pester 5. Runs on Windows PowerShell 5.1 and pwsh. Run: Invoke-Pester -Path .\tests -Output Detailed
# Running the tool must not rewrite tracked files: server\settings.json (defaults) and "Data Noodler.lnk".
BeforeAll {
    $script:repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    . (Join-Path $repo (Join-Path 'server' 'settings.ps1'))
    function New-Scratch {
        $d = Join-Path ([IO.Path]::GetTempPath()) ('dn-settings-' + [guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Force -Path $d)
        return $d
    }
    function New-FakeShortcut([string]$Icon) {
        $o = New-Object PSObject -Property @{ IconLocation = $Icon; Saved = 0 }
        $o | Add-Member -MemberType ScriptMethod -Name Save -Value { $this.Saved++ }
        return $o
    }
    function New-ShortcutRoot([switch]$Git, [switch]$GitFile) {
        $r = New-Scratch
        [IO.File]::WriteAllBytes((Join-Path $r 'Data Noodler.lnk'), [byte[]](1, 2, 3))
        [void](New-Item -ItemType Directory -Force -Path (Join-Path $r 'assets'))
        [IO.File]::WriteAllBytes((Join-Path (Join-Path $r 'assets') 'client_favicon.ico'), [byte[]](0))
        if ($Git) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $r '.git')) }
        if ($GitFile) { [IO.File]::WriteAllText((Join-Path $r '.git'), 'gitdir: C:/somewhere/worktrees/x') }
        return $r
    }
}

Describe 'Settings: tracked defaults plus a local file' {
    BeforeEach { $script:dir = New-Scratch; $script:def = Join-Path $dir 'settings.json'; $script:loc = Join-Path $dir 'settings.local.json' }
    AfterEach { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'uses the built-in defaults when neither file exists' {
        $s = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $s.port | Should -Be 47823
        $s.portMode | Should -Be 'manual'
        $s.theme | Should -Be 'dark'
    }

    It 'reads the tracked defaults file' {
        [IO.File]::WriteAllText($def, '{ "port": 18450, "portMode": "random", "theme": "light" }')
        $s = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $s.port | Should -Be 18450
        $s.portMode | Should -Be 'random'
        $s.theme | Should -Be 'light'
    }

    It 'the local file overrides the defaults file, key by key' {
        [IO.File]::WriteAllText($def, '{ "port": 18450, "browser": "chrome", "theme": "light" }')
        [IO.File]::WriteAllText($loc, '{ "port": 31000, "theme": "dark" }')
        $s = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $s.port | Should -Be 31000
        $s.theme | Should -Be 'dark'
        $s.browser | Should -Be 'chrome'
    }

    It 'falls back to the defaults when the local file is broken or has invalid values' {
        [IO.File]::WriteAllText($def, '{ "port": 18450, "theme": "light" }')
        [IO.File]::WriteAllText($loc, '{ not json')
        (Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc).port | Should -Be 18450
        [IO.File]::WriteAllText($loc, '{ "theme": "purple", "fileThreads": 999 }')
        $s = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $s.theme | Should -Be 'light'
        $s.fileThreads | Should -Be 64
    }

    It 'reads a local file written with a UTF-8 BOM (Windows PowerShell 5.1 Set-Content -Encoding UTF8)' {
        [IO.File]::WriteAllText($loc, '{ "port": 32000 }', (New-Object System.Text.UTF8Encoding $true))
        (Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc).port | Should -Be 32000
    }

    It 'Save writes only the local file and never touches the defaults file' {
        [IO.File]::WriteAllText($def, '{ "port": 18450, "theme": "light" }')
        $before = [IO.File]::ReadAllBytes($def)
        $stamp = (Get-Item -LiteralPath $def).LastWriteTimeUtc
        $s = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $s.port = 33333; $s.theme = 'dark'
        Save-NoodlerSettings -Settings $s -LocalFile $loc
        [IO.File]::ReadAllBytes($def) | Should -Be $before
        (Get-Item -LiteralPath $def).LastWriteTimeUtc | Should -Be $stamp
        Test-Path -LiteralPath ($loc + '.tmp') | Should -BeFalse
        $again = Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc
        $again.port | Should -Be 33333
        $again.theme | Should -Be 'dark'
        Save-NoodlerSettings -Settings $again -LocalFile $loc
        (Read-NoodlerSettings -DefaultsFile $def -LocalFile $loc).port | Should -Be 33333
    }
}

Describe 'Shortcut icon: never rewrites the tracked Data Noodler.lnk' {
    It 'skips a git checkout (.git folder) without opening the shortcut' {
        $r = New-ShortcutRoot -Git
        try {
            $opened = @{ N = 0 }
            Update-NoodlerShortcutIcon -Root $r -OpenShortcut ({ param($p) $null = $p; $opened.N++; New-FakeShortcut 'x' }.GetNewClosure()) | Should -Be 'skipped-git'
            $opened.N | Should -Be 0
        } finally { Remove-Item -LiteralPath $r -Recurse -Force }
    }

    It 'skips a git worktree (.git file)' {
        $r = New-ShortcutRoot -GitFile
        try { Update-NoodlerShortcutIcon -Root $r -OpenShortcut { param($p) $null = $p; throw 'must not open' } | Should -Be 'skipped-git' }
        finally { Remove-Item -LiteralPath $r -Recurse -Force }
    }

    It 'installed copy: saves only when the icon differs' {
        $r = New-ShortcutRoot
        try {
            $want = (Join-Path $r 'assets\client_favicon.ico') + ',0'
            $same = New-FakeShortcut $want
            Update-NoodlerShortcutIcon -Root $r -OpenShortcut ({ param($p) $null = $p; $same }.GetNewClosure()) | Should -Be 'unchanged'
            $same.Saved | Should -Be 0
            $other = New-FakeShortcut 'D:\elsewhere\client_favicon.ico,0'
            Update-NoodlerShortcutIcon -Root $r -OpenShortcut ({ param($p) $null = $p; $other }.GetNewClosure()) | Should -Be 'updated'
            $other.Saved | Should -Be 1
            $other.IconLocation | Should -Be $want
        } finally { Remove-Item -LiteralPath $r -Recurse -Force }
    }

    It 'does nothing when the shortcut is missing' {
        $r = New-Scratch
        try { Update-NoodlerShortcutIcon -Root $r -OpenShortcut { param($p) $null = $p; throw 'must not open' } | Should -Be 'missing' }
        finally { Remove-Item -LiteralPath $r -Recurse -Force }
    }
}

Describe 'server.ps1 wiring (static)' {
    BeforeAll { $script:server = [IO.File]::ReadAllText((Join-Path $repo (Join-Path 'server' 'server.ps1'))) }

    It 'loads settings through settings.ps1 and saves only to settings.local.json' {
        $server | Should -Match ([regex]::Escape(". (Join-Path `$here 'settings.ps1')"))
        $server | Should -Match ([regex]::Escape("Read-NoodlerSettings -DefaultsFile `$settingsFile -LocalFile `$settingsLocalFile"))
        $server | Should -Match ([regex]::Escape("Save-NoodlerSettings -Settings `$settings -LocalFile `$settingsLocalFile"))
        $server | Should -Not -Match 'Set-Content\s+\$settingsFile'
        $server | Should -Not -Match 'WriteAllText\(\s*\$settingsFile'
    }

    It 'updates the shortcut only through Update-NoodlerShortcutIcon' {
        $server | Should -Match 'Update-NoodlerShortcutIcon -Root \$root'
        $server | Should -Not -Match 'CreateShortcut'
    }

    It 'settings.local.json is gitignored' {
        [IO.File]::ReadAllText((Join-Path $repo '.gitignore')) | Should -Match '(?m)^server/settings\.local\.json\s*$'
    }
}
