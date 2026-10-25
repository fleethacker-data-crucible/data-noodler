# Pester 5. Runs on Windows PowerShell 5.1 and pwsh. Run: Invoke-Pester -Path .\tests -Output Detailed
# Running the tool must not rewrite tracked files (server\settings.json holds the defaults). "Data Noodler.lnk" is not
# tracked: it is made on each computer, and these tests cover its spec and the create-or-repair logic (COM mocked).
BeforeAll {
    $script:repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    . (Join-Path $repo (Join-Path 'server' 'settings.ps1'))
    function New-Scratch {
        $d = Join-Path ([IO.Path]::GetTempPath()) ('dn-settings-' + [guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Force -Path $d)
        return $d
    }
    # Stands in for the WScript.Shell shortcut object (no COM, no .lnk written).
    function New-FakeShortcut {
        param($Spec, [switch]$Blank)
        $o = New-Object PSObject -Property @{ TargetPath = ''; Arguments = ''; WorkingDirectory = ''; Description = ''; IconLocation = ''; WindowStyle = 1; Saved = 0 }
        if (-not $Blank) { foreach ($f in 'TargetPath', 'Arguments', 'WorkingDirectory', 'Description', 'IconLocation', 'WindowStyle') { $o.$f = $Spec.$f } }
        $o | Add-Member -MemberType ScriptMethod -Name Save -Value { $this.Saved++ }
        return $o
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

Describe 'Shortcut spec: Get-NoodlerShortcutSpec' {
    It 'matches the shortcut that used to be tracked (conhost --headless, relative server\server.ps1, minimized)' {
        $s = Get-NoodlerShortcutSpec -Root 'X:\tools\Data Noodler' -SystemRoot 'C:\Windows'
        $s.TargetPath | Should -BeExactly 'C:\Windows\System32\conhost.exe'
        $s.Arguments | Should -BeExactly '--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "server\server.ps1"'
        $s.WorkingDirectory | Should -Be ''
        $s.WindowStyle | Should -Be 7
        $s.Description | Should -Be ''
    }
    It 'derives the path and icon from the tool folder at run time' {
        $s = Get-NoodlerShortcutSpec -Root 'X:\tools\Data Noodler'
        $s.Path | Should -Be ([IO.Path]::Combine('X:\tools\Data Noodler', 'Data Noodler.lnk'))
        $s.IconLocation | Should -Be ([IO.Path]::Combine('X:\tools\Data Noodler', 'assets', 'client_favicon.ico') + ',0')
        $s.Path | Should -BeLike 'X:\tools\Data Noodler*Data Noodler.lnk'
        $s.IconLocation | Should -BeLike 'X:\tools\Data Noodler*client_favicon.ico,0'
    }
    It 'puts no absolute path in the arguments, and no SID or computer name anywhere' {
        $a = Get-NoodlerShortcutSpec -Root 'C:\one'; $b = Get-NoodlerShortcutSpec -Root 'D:\two\deeper'
        $a.Arguments | Should -BeExactly $b.Arguments
        $a.Arguments | Should -Not -Match '[A-Za-z]:\\'
        ($a | ConvertTo-Json) | Should -Not -Match '(?i)desktop-|S-1-5-21|Dev_Project_Repository'
    }
}

Describe 'Shortcut: Test-NoodlerShortcutMatch' {
    BeforeAll { $script:spec = Get-NoodlerShortcutSpec -Root 'C:\dn' }
    It 'matches regardless of casing and %SystemRoot% expansion' {
        $l = New-FakeShortcut $script:spec
        $l.TargetPath = $script:spec.TargetPath.ToUpperInvariant()
        Test-NoodlerShortcutMatch -Shortcut $l -Spec $script:spec | Should -BeTrue
    }
    It 'does not match when <_> differs' -ForEach @('TargetPath', 'Arguments', 'WorkingDirectory', 'IconLocation') {
        $l = New-FakeShortcut $script:spec
        $l.$_ = 'D:\Dev_Project_Repository\web-pages\data-noodler\assets\client_favicon.ico,0'
        Test-NoodlerShortcutMatch -Shortcut $l -Spec $script:spec | Should -BeFalse
    }
    It 'does not match another window style' {
        $l = New-FakeShortcut $script:spec; $l.WindowStyle = 1
        Test-NoodlerShortcutMatch -Shortcut $l -Spec $script:spec | Should -BeFalse
    }
}

Describe 'Shortcut: Sync-NoodlerShortcut (COM mocked)' {
    BeforeEach { $script:r = New-Scratch }
    AfterEach { Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue }

    It 'creates the shortcut when it is missing (also in a git checkout: it is no longer tracked)' {
        [void](New-Item -ItemType Directory -Force -Path (Join-Path $r '.git'))
        $mk = ${function:New-FakeShortcut}; $box = @{}
        Sync-NoodlerShortcut -Root $r -OpenShortcut ({ param($p) $box.P = $p; $box.L = & $mk -Blank; $box.L }.GetNewClosure()) | Should -Be 'created'
        $box.P | Should -Be ([IO.Path]::Combine($r, 'Data Noodler.lnk'))
        $box.L.Saved | Should -Be 1
        Test-NoodlerShortcutMatch -Shortcut $box.L -Spec (Get-NoodlerShortcutSpec -Root $r) | Should -BeTrue
    }
    It 'leaves a matching shortcut alone (no Save)' {
        $spec = Get-NoodlerShortcutSpec -Root $r
        [IO.File]::WriteAllBytes($spec.Path, [byte[]](1, 2, 3))
        $same = New-FakeShortcut $spec
        Sync-NoodlerShortcut -Root $r -OpenShortcut ({ param($p) $null = $p; $same }.GetNewClosure()) | Should -Be 'unchanged'
        $same.Saved | Should -Be 0
    }
    It 'repairs a shortcut with a stale icon path (folder moved)' {
        $spec = Get-NoodlerShortcutSpec -Root $r
        [IO.File]::WriteAllBytes($spec.Path, [byte[]](1, 2, 3))
        $old = New-FakeShortcut $spec; $old.IconLocation = 'D:\elsewhere\assets\client_favicon.ico,0'
        Sync-NoodlerShortcut -Root $r -OpenShortcut ({ param($p) $null = $p; $old }.GetNewClosure()) | Should -Be 'repaired'
        $old.Saved | Should -Be 1
        $old.IconLocation | Should -Be $spec.IconLocation
    }
    It 'is idempotent: the second run writes nothing' {
        $mk = ${function:New-FakeShortcut}; $store = @{}
        $open = { param($p) if (-not $store.ContainsKey($p)) { $store[$p] = & $mk -Blank }; $store[$p] }.GetNewClosure()
        Sync-NoodlerShortcut -Root $r -OpenShortcut $open | Should -Be 'created'
        [IO.File]::WriteAllBytes((Join-Path $r 'Data Noodler.lnk'), [byte[]](1))   # the fake Save writes no file
        Sync-NoodlerShortcut -Root $r -OpenShortcut $open | Should -Be 'unchanged'
        $store[(Join-Path $r 'Data Noodler.lnk')].Saved | Should -Be 1
    }
    It 'never throws when COM is unavailable or Save fails' {
        Sync-NoodlerShortcut -Root $r -OpenShortcut { param($p) $null = $p; throw 'Retrieving the COM class factory failed' } | Should -Be 'unavailable'
        $bad = { param($p) $null = $p; $o = New-Object PSObject -Property @{ TargetPath = ''; Arguments = ''; WorkingDirectory = ''; Description = ''; IconLocation = ''; WindowStyle = 1 }; $o | Add-Member -MemberType ScriptMethod -Name Save -Value { throw 'Access is denied' }; $o }
        Sync-NoodlerShortcut -Root $r -OpenShortcut $bad | Should -Be 'unavailable'
    }
}

Describe 'Launcher and git' {
    It 'Data_Noodler.bat runs Start-DataNoodler.ps1 with powershell.exe -File (CONVENTIONS)' {
        [IO.File]::ReadAllText((Join-Path $repo 'Data_Noodler.bat')) | Should -Match 'powershell\.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0Start-DataNoodler\.ps1" %\*'
    }
    It 'Start-DataNoodler.ps1 makes the shortcut, then starts the server' {
        $t = [IO.File]::ReadAllText((Join-Path $repo 'Start-DataNoodler.ps1'))
        $t | Should -Match 'Sync-NoodlerShortcut -Root \$root'
        $t | Should -Match 'Start-Process'
    }
    It '.gitignore ignores *.lnk and no .lnk is tracked' {
        [IO.File]::ReadAllText((Join-Path $repo '.gitignore')) | Should -Match '(?m)^\*\.lnk\s*$'
        if (Get-Command git -ErrorAction SilentlyContinue) {
            Push-Location $repo
            try { $tracked = @(git ls-files -- '*.lnk' 2>$null) } finally { Pop-Location }
            $tracked | Should -BeNullOrEmpty
        }
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

    It 'makes or repairs the shortcut only through Sync-NoodlerShortcut' {
        $server | Should -Match 'Sync-NoodlerShortcut -Root \$root'
        $server | Should -Not -Match 'CreateShortcut'
    }

    It 'settings.local.json is gitignored' {
        [IO.File]::ReadAllText((Join-Path $repo '.gitignore')) | Should -Match '(?m)^server/settings\.local\.json\s*$'
    }
}
