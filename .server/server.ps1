# Data Noodler dev server.
# Serves the project root (one dir up) on the site port, and the control panel
# (this folder) on the UI port. Exits when the control panel window closes.
$ErrorActionPreference = 'Stop'
$startSw = [Diagnostics.Stopwatch]::StartNew()   # load time, shown in the panel

# Any error that would stop the server before the panel can show it: write it to the log
# file and show a message box (the PowerShell window is hidden). No admin needed.
function Show-Fatal([string]$text) {
    try { [IO.File]::AppendAllText($logFile, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  [FATAL] $text`r`n") } catch {}
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("Data Noodler server could not start.`n`n$text`n`nLog: $logFile", 'Data Noodler Server',
            [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {}
}
trap { Show-Fatal "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"; exit 1 }
$script:loadMs = 0
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '..')).Path
# Temporary files of this process (Add-Type compiler scratch, .NET temp) stay in the project: <root>\temp\sys.
$env:TEMP = Join-Path $root 'temp\sys'; $env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$uiPort = 8079
$settingsFile = Join-Path $here 'settings.json'
$logFile = Join-Path $here ('logs\Data_Noodler_Server_Logs_{0:yyyy_MM_dd_HHmmss}.log' -f (Get-Date))
New-Item -ItemType Directory -Force (Split-Path $logFile) | Out-Null

$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
    '.css' = 'text/css'; '.json' = 'application/json'; '.wasm' = 'application/wasm'
    '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'
    '.woff' = 'font/woff'; '.woff2' = 'font/woff2'; '.ttf' = 'font/ttf'; '.csv' = 'text/csv'
    '.parquet' = 'application/vnd.apache.parquet'
    '.arrow' = 'application/vnd.apache.arrow.file'
}

# --- settings ---
# fileThreads = how many file requests are served at the same time (background runspaces).
# portMode = 'manual' (keep port) or 'random' (new 5-digit port each time the site starts). browser = 'edge' or 'chrome' for Open Module.
# theme = 'dark' or 'light': one setting for every window (panel and site), so they all follow the toggle.
# engineWorkers = max C# engine worker threads (capped at 64 and at the CPU's logical cores).
# engineMemory = share of physical RAM the engine may hold (0.1 - 0.9).
# App entry point (hard-coded): the site's "/" and the app window open this page.
$entryPage = 'html/project_manager.html'
$settings = @{ port = 47823; portMode = 'manual'; browser = 'edge'; theme = 'dark'; fileThreads = 16; engineWorkers = 64; engineMemory = 0.5 }
if (Test-Path $settingsFile) {
    try {
        $j = Get-Content $settingsFile -Raw | ConvertFrom-Json
        if ($j.port) { $settings.port = [int]$j.port }
        if ($j.portMode -in 'manual', 'random') { $settings.portMode = [string]$j.portMode }
        if ($j.browser -in 'edge', 'chrome') { $settings.browser = [string]$j.browser }
        if ($j.theme -in 'dark', 'light') { $settings.theme = [string]$j.theme }
        if ($j.fileThreads) { $settings.fileThreads = [Math]::Max(1, [Math]::Min(64, [int]$j.fileThreads)) }
        if ($j.engineWorkers) { $settings.engineWorkers = [Math]::Max(1, [Math]::Min(64, [int]$j.engineWorkers)) }
        if ($j.engineMemory) { $settings.engineMemory = [Math]::Max(0.1, [Math]::Min(0.9, [double]$j.engineMemory)) }
    } catch {}
}
function Save-Settings { $settings | ConvertTo-Json | Set-Content $settingsFile -Encoding UTF8 }
# Light/dark for every window; saved so windows opened later use it too.
function Set-Theme([string]$t) {
    if ($t -notin 'dark', 'light') { throw 'Theme must be dark or light.' }
    if ($settings.theme -ne $t) { $settings.theme = $t; Save-Settings }
}

# --- log ---
$log = [System.Collections.Generic.List[object]]::new()
$script:seq = 0
$script:hits = 0
$started = Get-Date

# Every entry is appended to this session's log file immediately and kept in
# memory for the panel.
function Add-Log($kind, $path, $code = 0, $method = '', $size = 0, $ms = 0) {
    $script:seq++
    $now = Get-Date
    $log.Add([ordered]@{ i = $script:seq; t = $now.ToString('yyyy-MM-dd HH:mm:ss'); k = $kind; c = $code; m = $method; p = $path; s = $size; ms = $ms })
    if ($log.Count -gt 2000) { $log.RemoveRange(0, 500) }
    $stamp = $now.ToString('yyyy-MM-dd HH:mm:ss')
    $line = if ($kind -eq 'req') {
        '{0}  {1,-6} {2}  {3,10} B  {4,5} ms  {5}' -f $stamp, $method, $code, $size, $ms, $path
    } else { '{0}  [{1}] {2}' -f $stamp, $kind.ToUpper(), $path }
    try { [IO.File]::AppendAllText($logFile, $line + "`r`n") } catch {}
}

function Get-Pages { @(Get-ChildItem -Path (Join-Path $root 'html') -Filter *.html -File | Sort-Object Name | ForEach-Object { @{ name = "html/$($_.Name)"; size = $_.Length } }) }

# --- http helpers ---
function Send($res, [byte[]]$bytes, $type) {
    $res.ContentType = $type
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function Send-Json($res, $obj) { Send $res ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 5 -Compress))) 'application/json' }
function Read-Json($req) { [IO.StreamReader]::new($req.InputStream).ReadToEnd() | ConvertFrom-Json }

# Per-session secret the file API requires. Injected into served .html pages.
$fsToken = [Guid]::NewGuid().ToString('N')
$tokenTag = "<script>window.DN_TOKEN='$fsToken'</script>"

# Streams a file to the response; returns bytes sent.
# Honours a single "Range: bytes=a-b" request (206) so a client can read only the
# parts of a file it needs, and HEAD (headers only).
# $prog (optional, synchronized hashtable): .at / .done are updated per chunk so a stalled read can be detected.
function Send-Stream($res, $path, $req, $prog) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    $res.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers['Cache-Control'] = 'no-store'
    $res.AddHeader('Accept-Ranges', 'bytes')
    # Last-Modified for HTTP readers that compute file age.
    $mtime = [IO.File]::GetLastWriteTimeUtc($path)
    $res.AddHeader('Last-Modified', $mtime.ToString('R'))
    $res.AddHeader('ETag', '"' + $mtime.Ticks.ToString('x') + '"')
    $fs = [IO.File]::OpenRead($path)
    try {
        $len = $fs.Length; $start = 0; $end = $len - 1
        $range = if ($req) { $req.Headers['Range'] }
        if ($range -match '^bytes=(\d*)-(\d*)$') {
            if ($Matches[1] -eq '') { $start = [Math]::Max(0, $len - [long]$Matches[2]) }
            else {
                $start = [long]$Matches[1]
                if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $len - 1) }
            }
            if ($start -ge $len -or $start -gt $end) {
                $res.StatusCode = 416; $res.AddHeader('Content-Range', "bytes */$len"); $res.ContentLength64 = 0
                return 0
            }
            $res.StatusCode = 206
            $res.AddHeader('Content-Range', "bytes $start-$end/$len")
        }
        $count = $end - $start + 1
        $res.ContentLength64 = $count
        if ($req -and $req.HttpMethod -eq 'HEAD') { return 0 }
        $fs.Position = $start
        $buf = [byte[]]::new([Math]::Min(1MB, [Math]::Max(1, $count)))
        $left = $count
        while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $left))
            if ($n -le 0) { break }
            $res.OutputStream.Write($buf, 0, $n)
            $left -= $n
            if ($prog) { $prog.at = [DateTime]::UtcNow; $prog.done = $count - $left }
        }
        return $count - $left
    } finally { $fs.Dispose() }
}

# Serve a file under $base; returns bytes sent, or -1 if not found.
# With -Token, .html pages get the file API token injected before </head>.
function Send-File($res, $base, $rel, [switch]$Token, $req) {
    if ($rel -split '[\\/]' | Where-Object { $_.StartsWith('.') }) { return -1 }
    $path = [IO.Path]::GetFullPath((Join-Path $base $rel))
    if (-not $path.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) { return -1 }
    if ($Token -and $path -like '*.html') {
        $html = [IO.File]::ReadAllText($path)
        $i = $html.IndexOf('</head>', [StringComparison]::OrdinalIgnoreCase)
        $html = if ($i -ge 0) { $html.Insert($i, $tokenTag) } else { $tokenTag + $html }
        $bytes = [Text.Encoding]::UTF8.GetBytes($html)
        $res.Headers['Cache-Control'] = 'no-store'
        Send $res $bytes 'text/html; charset=utf-8'
        return $bytes.Length
    }
    return Send-Stream $res $path $req
}

# --- listener ---
# Stop a previous instance still holding the ports.
$pidFile = Join-Path $here '.pid'
if (Test-Path $pidFile) {
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$([int](Get-Content $pidFile))" -ErrorAction SilentlyContinue
    if ($old -and $old.CommandLine -like '*server.ps1*') {
        Stop-Process -Id $old.ProcessId -Force
        Start-Sleep -Milliseconds 500
        Add-Log 'sys' "Stopped previous server instance (PID $($old.ProcessId))."
    }
}
Set-Content $pidFile $PID

# Clear upload temp files left by a crash.
Remove-Item (Join-Path $root 'temp\upload-*.tmp') -Force -ErrorAction SilentlyContinue

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$uiPort/")
try { $listener.Start() }
catch { Show-Fatal "Control panel port $uiPort is in use or blocked: $($_.Exception.Message)"; exit 1 }

function Test-PortFree([int]$p) {
    try { $t = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $t.Start(); $t.Stop(); $true } catch { $false }
}

# Moves the site to port $p (rebinding if the site is running).
function Set-SitePort([int]$p) {
    if ($p -ne 80 -and ($p -lt 1024 -or $p -gt 65535)) { throw 'Port must be 1024-65535 (or 80). Ports below 1024 are reserved for the system.' }
    if ($p -eq $uiPort) { throw "Port $uiPort is used by the control panel." }
    if ($script:siteUp -and $p -ne $settings.port) {
        $old = "http://localhost:$($settings.port)/"
        $listener.Prefixes.Remove($old) | Out-Null
        try { $listener.Prefixes.Add("http://localhost:$p/") }
        catch {
            try { $listener.Prefixes.Add($old) } catch {}
            throw "Port $p is unavailable."
        }
    }
    if ($script:siteUp -and $p -ne $settings.port) { $script:siteStarted = Get-Date }
    $settings.port = $p
}

# A free 5-digit port (10000-65535), other than the current one.
function Get-RandomPort {
    for ($n = 0; $n -lt 25; $n++) {
        $c = Get-Random -Minimum 10000 -Maximum 65536
        if ($c -ne $settings.port -and (Test-PortFree $c)) { return $c }
    }
    throw 'Could not find a free port.'
}

function Start-Site {
    if ($script:siteUp) { return }
    # Random mode: a new port when the server process starts; Stop/Start keeps it, so open module windows reconnect.
    if ($settings.portMode -eq 'random' -and -not $script:portPicked) { $settings.port = Get-RandomPort; Save-Settings }
    $script:portPicked = $true
    # The data engine runs with the site: Stop disposes it, Start creates a fresh one (compiled assembly stays loaded).
    # It must answer a test query before the site opens, so nothing reports ONLINE until both are ready.
    if (-not $script:engine) {
        if (-not ('NativeDataEngine.DataEngine' -as [type])) { throw $script:engineError }
        try { $script:engine = New-DataEngine -Root $root -MaxWorkers $settings.engineWorkers -MemoryFraction $settings.engineMemory }
        catch { $script:engineError = "Engine failed to start: $($_.Exception.Message)"; throw $script:engineError }
    }
    try {
        $v = New-Object 'System.Collections.Generic.Dictionary[string,string]'
        $r = $script:engine.Query('SELECT sum(range) AS s FROM range(1000)', $v, 1, 0, [Threading.CancellationToken]::None)
        if ($r.Batches[0].Cols[0].I[0] -ne 499500) { throw 'wrong answer to the test query' }
    } catch {
        try { $script:engine.Dispose() } catch {}
        $script:engine = $null; $script:engineError = "Engine failed its start-up test: $($_.Exception.Message)"; throw $script:engineError
    }
    Add-Log 'engine' 'Engine started and ready.'
    try { $listener.Prefixes.Add("http://localhost:$($settings.port)/") }
    catch { throw "Port $($settings.port) is unavailable. Pick another port." }
    $script:siteUp = $true
    $script:siteStarted = Get-Date
    Add-Log 'start' 'SERVER STARTED'; Add-Log 'sys' "Site online. Serving $($entryPage) at http://localhost:$($settings.port)/"
}

# Opens the selected module in $name (default: the Settings browser). Returns an error message or $null.
# $page (optional, e.g. 'html/benchmark.html'): open that page instead, for testing; the default is unchanged.
# Pages that live in the app shell (they load js/core/embed.js) open as html/app.html?m=<name> directly,
# so the browser doesn't load the page, get redirected and cancel its half-loaded files.
function Get-ShellUrl([string]$page) {
    $file = Join-Path $root $page
    # Every page opens on its own (no app shell); the global header comes from js/core/embed.js.
    return $page
}

function Open-Site([string]$name, [string]$page) {
    if (-not $name) { $name = $settings.browser }
    if ($page -and ($page -notmatch '^html/[\w.-]+\.html$' -or -not (Test-Path (Join-Path $root $page) -PathType Leaf))) { return "$page not found." }
    $exe = if ($browsers.ContainsKey($name)) { Find-Browser $name }
    if (-not $script:siteUp) { return 'Start the server first.' }
    if (-not $exe) { Add-Log 'err' "Browser '$name' not found."; return "$name is not installed." }
    Raise-Window (Open-App $exe "http://localhost:$($settings.port)/$(Get-ShellUrl $(if ($page) { $page } else { $entryPage }))" ".profile-site-$name")
    Add-Log 'sys' "Opened $(if ($page) { "$page (test)" } else { $entryPage }) in $name."
    return $null
}

function Stop-Site {
    if (-not $script:siteUp) { return }
    $listener.Prefixes.Remove("http://localhost:$($settings.port)/") | Out-Null
    $script:siteUp = $false
    if ($script:engine) {
        try { $script:engine.Dispose() } catch {}
        $script:engine = $null; $script:engineError = 'The data engine is stopped (the server is stopped).'
        Add-Log 'engine' 'Engine stopped.'
    }
    $script:hits = 0   # requests are counted per up session
    Add-Log 'stop' 'SERVER STOPPED'; Add-Log 'sys' "Site offline. Port $($settings.port) released."
}

$script:siteUp = $false
Add-Log 'sys' "Server started. PID $PID, PowerShell $($PSVersionTable.PSVersion), user $env:USERNAME on $env:COMPUTERNAME"
Add-Log 'sys' "Root: $root"
Add-Log 'sys' "Control panel at $("http://localhost:$uiPort/"). Log file: $logFile"
Add-Log 'sys' 'Site offline. Click Start server to begin.'

# --- api ---
function Handle-Ui($req, $res, $rel) {
    switch ($rel) {
        'api/state' {
            Send-Json $res @{
                ps = "$($PSVersionTable.PSVersion)"; loadMs = $script:loadMs; theme = $settings.theme
                port = $settings.port; portMode = $settings.portMode; browser = $settings.browser; entry = $entryPage; up = $script:siteUp; engine = [bool]$script:engine; root = $root; user = $env:USERNAME
                pages = Get-Pages; hits = $script:hits; uptime = $(if ($script:siteUp) { [int]((Get-Date) - $script:siteStarted).TotalSeconds } else { 0 })
            }
        }
        'api/log' {
            $since = [int]$req.QueryString['since']
            Send-Json $res @{ lines = @($log | Where-Object { $_.i -gt $since }) }
        }
        'api/settings' {
            $body = Read-Json $req
            try {
                if ($body.port) { Set-SitePort ([int]$body.port) }
                if ($body.portMode) { if ($body.portMode -notin 'manual', 'random') { throw 'Invalid port mode.' }; $settings.portMode = [string]$body.portMode }
                if ($body.browser) { if ($body.browser -notin 'edge', 'chrome') { throw 'Invalid browser.' }; $settings.browser = [string]$body.browser }
                if ($body.theme) { Set-Theme ([string]$body.theme) }
                Save-Settings
                if ($body.port -or $body.portMode -or $body.browser) { Add-Log 'sys' "Settings applied: port $($settings.port) ($($settings.portMode)), browser $($settings.browser)" }
                Send-Json $res @{ ok = $true }
            } catch {
                Add-Log 'err' $_.Exception.Message
                Send-Json $res @{ ok = $false; error = $_.Exception.Message }
            }
        }
        'api/site' {
            try {
                if ((Read-Json $req).on) { Start-Site } else { Stop-Site }
                Send-Json $res @{ ok = $true }
            } catch {
                Add-Log 'err' $_.Exception.Message
                Send-Json $res @{ ok = $false; error = $_.Exception.Message }
            }
        }
        'api/clientlog' {
            $body = Read-Json $req
            Add-Log $(if ($body.level -in 'err', 'engine') { $body.level } else { 'client' }) ([string]$body.text)
            Send-Json $res @{ ok = $true }
        }
        'api/open' {
            $body = Read-Json $req
            $err = Open-Site ([string]$body.browser) ([string]$body.page)
            Send-Json $res $(if ($err) { @{ ok = $false; error = $err } } else { @{ ok = $true } })
        }
        'api/clear' { $log.Clear(); Send-Json $res @{ ok = $true } }
        # Purge Temp Data: deletes everything in <root>	emp it can (files in use, e.g. the loaded engine DLL or an open
        # app window's browser profile, are skipped). Purge Project Trash: deletes projects\.trash.
        'api/purge' {
            $body = Read-Json $req
            $dir = if ($body.what -eq 'trash') { Join-Path $root 'projects\.trash' } elseif ($body.what -eq 'temp') { Join-Path $root 'temp' } else { $null }
            if (-not $dir) { Send-Json $res @{ ok = $false; error = 'Unknown purge.' }; break }
            $bytes = 0; $skipped = 0
            if ($body.what -eq 'temp' -and $script:engine) { try { [void]$script:engine.CacheDrop($null) } catch {} }
            if (Test-Path -LiteralPath $dir) {
                foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue)) {
                    try { $len = $f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $bytes += $len } catch { $skipped++ }
                }
                foreach ($d in @(Get-ChildItem -LiteralPath $dir -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending)) {
                    try { Remove-Item -LiteralPath $d.FullName -Force -ErrorAction Stop } catch {}
                }
            }
            $mb = [Math]::Round($bytes / 1MB, 1)
            $what = if ($body.what -eq 'trash') { 'Project trash' } else { 'Temp data' }
            Add-Log 'sys' "$what purged: $mb MB freed$(if ($skipped) { ", $skipped file(s) in use skipped" })."
            Send-Json $res @{ ok = $true; mb = $mb; skipped = $skipped }
        }
        # User list shared by the whole project: config/users.json (site pages read it at /config/users.json).
        'api/users' {
            $file = Join-Path $root 'config\users.json'
            if ($req.HttpMethod -eq 'POST') {
                $text = [IO.StreamReader]::new($req.InputStream).ReadToEnd()
                try { $null = $text | ConvertFrom-Json } catch { Send-Json $res @{ ok = $false; error = 'Invalid user list.' }; break }
                New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
                [IO.File]::WriteAllText($file, $text, [Text.UTF8Encoding]::new($false))
                Add-Log 'sys' 'User list saved to config/users.json'
                Send-Json $res @{ ok = $true }
            } else {
                $text = if (Test-Path $file) { [IO.File]::ReadAllText($file) } else { '[]' }
                Send $res ([Text.Encoding]::UTF8.GetBytes($text)) 'application/json'
            }
        }
        # Panel engine check: one query through the native engine + its status.
        'api/engine' {
            if (-not $engine) { Send-Json $res @{ ok = $false; error = $script:engineError }; break }
            $out = $null
            try {
                $sw = [Diagnostics.Stopwatch]::StartNew()
                $v = New-Object 'System.Collections.Generic.Dictionary[string,string]'
                $r = $engine.Query('SELECT sum(range) AS s FROM range(1000000)', $v, 1, 0, [Threading.CancellationToken]::None)
                $got = $r.Batches[0].Cols[0].I[0]
                if ($got -ne 499999500000) { throw "wrong answer: $got" }
                $st = $engine.Status(); $st['ms'] = $sw.ElapsedMilliseconds
                $out = [NativeDataEngine.Json]::Write($st)
            } catch { $out = ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message } }
            Send $res ([Text.Encoding]::UTF8.GetBytes($out)) 'application/json'
        }
        default {
            if ($rel -eq '') { $rel = 'server.html' }
            if ($rel -eq 'favicon.ico') { $sent = Send-File $res $root 'assets/server_favicon.ico' -req $req }
            else { $sent = Send-File $res $here $rel -req $req }
            if ($sent -lt 0) { $res.StatusCode = 404 }
        }
    }
}

# --- file api ---
# Pages served by this site can read and write files inside the project root,
# and nowhere else. Paths are relative to the root ("test-data/sales.csv").
# Blocked: anything outside root, dot-folders (.server, .git), and links (junctions/
# symlinks) that could point outside. Requests must come from this site with the token.

class FsError : Exception { [int]$Code; FsError([int]$c, [string]$m) : base($m) { $this.Code = $c } }

# Drive part of a path: "X:" or "\\server\share".
function Get-DriveName([string]$path) {
    if ($path -match '^(\\\\[^\\]+\\[^\\]+)') { return $Matches[1] }
    if ($path -match '^([A-Za-z]:)') { return $Matches[1] }
    return $path
}

# Turns a .NET file error into a plain-English FsError: permission denied, not found,
# drive unavailable, file in use, or a read/write error. $what = 'read' / 'write' / ...
function ConvertTo-FsError($err, [string]$path, [string]$what) {
    if ($err -is [FsError]) { return $err }
    $code = $err.HResult -band 0xFFFF
    $drive = Get-DriveName $path
    if ($drive -ne $path -and $err.GetType().Name -match 'NotFound' -and -not [IO.Directory]::Exists("$drive\")) {
        return [FsError]::new(503, "Drive $drive is not available (disconnected, not mapped or not responding).")
    }
    switch -Regex ($err.GetType().Name) {
        'UnauthorizedAccess' { return [FsError]::new(403, "Permission denied ($what): $path") }
        'DirectoryNotFound' { return [FsError]::new(404, "Folder not found: $(Split-Path $path)") }
        'FileNotFound' { return [FsError]::new(404, "File not found: $path") }
        'DriveNotFound' { return [FsError]::new(503, "Drive $drive is not available.") }
    }
    # Win32 codes: 53/67/64/59/1231 = network path gone, 21 = device not ready, 32/33 = in use.
    if ($code -in 53, 67, 64, 59, 1231, 21) { return [FsError]::new(503, "Drive $drive is not available (network or device not responding).") }
    if ($code -in 32, 33) { return [FsError]::new(423, "File is in use by another program ($what): $path") }
    if ($code -eq 5) { return [FsError]::new(403, "Permission denied ($what): $path") }
    if ($code -eq 112) { return [FsError]::new(507, "Disk full ($what): $path") }
    return [FsError]::new(500, "Error during $what of ${path}: $($err.Message)")
}

# Resolves a relative project path to a full path, or throws FsError.
function Resolve-ProjectPath([string]$rel, [switch]$AllowRoot) {
    $rel = ($rel -replace '\\', '/').Trim('/')
    if (-not $rel -and -not $AllowRoot) { throw [FsError]::new(400, 'Path required.') }
    if ($rel -match '^[a-zA-Z]:|^//|:') { throw [FsError]::new(403, 'Absolute paths are not allowed.') }
    foreach ($seg in $rel -split '/') {
        if ($seg -eq '..') { throw [FsError]::new(403, 'Path is outside the project.') }
        if ($seg.StartsWith('.')) { throw [FsError]::new(403, "Access to '$seg' is not allowed.") }
    }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel)).TrimEnd('\')
    if ($full -ne $root -and -not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
        throw [FsError]::new(403, 'Path is outside the project.')
    }
    # Reject links anywhere along the path.
    $p = $full
    while ($p.Length -gt $root.Length) {
        if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw [FsError]::new(403, 'Links are not allowed.')
        }
        $p = Split-Path $p
    }
    return $full
}

# Same-site check: right Host (stops DNS rebinding), no foreign Origin, valid token.
function Test-FsRequest($req) {
    $hostOk = $req.Headers['Host'] -in "localhost:$($settings.port)", "127.0.0.1:$($settings.port)"
    $origin = $req.Headers['Origin']
    $originOk = -not $origin -or $origin -in "http://localhost:$($settings.port)", "http://127.0.0.1:$($settings.port)"
    $tokenOk = $req.Headers['X-DN-Token'] -eq $fsToken
    return $hostOk -and $originOk -and $tokenOk
}

function Get-Entry($item) {
    $rel = $item.FullName.Substring($root.Length).TrimStart('\') -replace '\\', '/'
    @{ name = $item.Name; path = $rel; dir = $item.PSIsContainer; size = $(if ($item.PSIsContainer) { 0 } else { $item.Length }); modified = $item.LastWriteTimeUtc.ToString('o') }
}

# Handles /api/fs/<op>; returns bytes sent.
function Handle-Fs($req, $res, $op) {
    if (-not (Test-FsRequest $req)) { throw [FsError]::new(403, 'Forbidden: request did not come from this site.') }
    $q = $req.QueryString
    switch ($op) {
        'list' {
            $dir = Resolve-ProjectPath $q['path'] -AllowRoot
            if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw [FsError]::new(404, 'Folder not found.') }
            $items = Get-ChildItem -LiteralPath $dir -Force -Recurse:($q['recursive'] -eq '1') |
                Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.FullName.Substring($root.Length) -notmatch '\\\.' }
            Send-Json $res @{ entries = @($items | ForEach-Object { Get-Entry $_ }) }
        }
        'stat' {
            $path = Resolve-ProjectPath $q['path'] -AllowRoot
            if (-not (Test-Path -LiteralPath $path)) { Send-Json $res @{ exists = $false }; break }
            $e = Get-Entry (Get-Item -LiteralPath $path -Force); $e.exists = $true
            Send-Json $res $e
        }
        'read' {
            $path = Resolve-ProjectPath $q['path']
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw [FsError]::new(404, 'File not found.') }
            return Send-Stream $res $path $req
        }
        'write' {
            # Body is the raw file content. Written to a temp file first, then swapped in.
            if ($req.HttpMethod -notin 'PUT', 'POST') { throw [FsError]::new(405, 'Use PUT or POST.') }
            $path = Resolve-ProjectPath $q['path']
            if (Test-Path -LiteralPath $path -PathType Container) { throw [FsError]::new(409, 'A folder exists at that path.') }
            if ($q['overwrite'] -eq '0' -and (Test-Path -LiteralPath $path)) { throw [FsError]::new(409, 'File already exists.') }
            New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
            Resolve-ProjectPath $q['path'] | Out-Null   # re-check now that folders exist
            $tmpDir = Join-Path $root 'temp'
            New-Item -ItemType Directory -Force $tmpDir | Out-Null
            $tmp = Join-Path $tmpDir "upload-$([Guid]::NewGuid().ToString('N')).tmp"
            $fs = [IO.File]::Create($tmp)
            try { $req.InputStream.CopyTo($fs, 1MB) }
            catch { $fs.Dispose(); Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
            finally { $fs.Dispose() }
            Move-Item -LiteralPath $tmp -Destination $path -Force
            Send-Json $res (Get-Entry (Get-Item -LiteralPath $path))
        }
        'mkdir' {
            $path = Resolve-ProjectPath $q['path']
            New-Item -ItemType Directory -Force $path | Out-Null
            Send-Json $res (Get-Entry (Get-Item -LiteralPath $path))
        }
        'delete' {
            if ($req.HttpMethod -notin 'DELETE', 'POST') { throw [FsError]::new(405, 'Use DELETE or POST.') }
            $path = Resolve-ProjectPath $q['path']
            if (-not (Test-Path -LiteralPath $path)) { throw [FsError]::new(404, 'Not found.') }
            if ((Test-Path -LiteralPath $path -PathType Container) -and $q['recursive'] -ne '1' -and (Get-ChildItem -LiteralPath $path -Force)) {
                throw [FsError]::new(409, 'Folder is not empty. Pass recursive=1.')
            }
            Remove-Item -LiteralPath $path -Recurse -Force
            Send-Json $res @{ ok = $true }
        }
        'move' {
            if ($req.HttpMethod -ne 'POST') { throw [FsError]::new(405, 'Use POST.') }
            $from = Resolve-ProjectPath $q['from']; $to = Resolve-ProjectPath $q['to']
            if (-not (Test-Path -LiteralPath $from)) { throw [FsError]::new(404, 'Source not found.') }
            if ((Test-Path -LiteralPath $to) -and $q['overwrite'] -ne '1') { throw [FsError]::new(409, 'Destination exists. Pass overwrite=1.') }
            New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
            Move-Item -LiteralPath $from -Destination $to -Force
            Send-Json $res (Get-Entry (Get-Item -LiteralPath $to))
        }
        'copy' {
            # Copies a file or a whole folder (recursive). Used by Archives snapshots and restores.
            if ($req.HttpMethod -ne 'POST') { throw [FsError]::new(405, 'Use POST.') }
            $from = Resolve-ProjectPath $q['from']; $to = Resolve-ProjectPath $q['to']
            if (-not (Test-Path -LiteralPath $from)) { throw [FsError]::new(404, 'Source not found.') }
            if ((Test-Path -LiteralPath $to) -and $q['overwrite'] -ne '1') { throw [FsError]::new(409, 'Destination exists. Pass overwrite=1.') }
            if ($to.StartsWith("$from\", [StringComparison]::OrdinalIgnoreCase)) { throw [FsError]::new(400, 'Cannot copy a folder into itself.') }
            New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
            Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
            Send-Json $res (Get-Entry (Get-Item -LiteralPath $to))
        }
        default { throw [FsError]::new(404, "Unknown file API call '$op'.") }
    }
    return 0
}

# --- parallel static files ---
# Plain file requests (data, js, wasm; not .html, not the API) are served on a pool of
# background runspaces, so many files can be served at the same time.
# Each job returns a log record; the main loop writes it to the log when the job ends.
$iss = [Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$iss.Commands.Add([Management.Automation.Runspaces.SessionStateFunctionEntry]::new('Send-Stream', ${function:Send-Stream}.ToString()))
$iss.Variables.Add([Management.Automation.Runspaces.SessionStateVariableEntry]::new('mime', $mime, ''))
$staticPool = [RunspaceFactory]::CreateRunspacePool(1, $settings.fileThreads, $iss, $Host)
$staticPool.Open()
Add-Log 'sys' "File requests: up to $($settings.fileThreads) at a time (settings.json fileThreads)."
$staticJobs = [Collections.Generic.List[object]]::new()
$staticScript = {
    param($ctx, $path, $logPath)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $req = $ctx.Request; $res = $ctx.Response; $size = 0; $err = $null
    try {
        $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
        $res.AddHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        $res.AddHeader('Cross-Origin-Resource-Policy', 'same-origin')
        $size = Send-Stream $res $path $req
    } catch {
        $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
        $err = $e; try { $res.StatusCode = 500 } catch {}
    }
    finally { try { $res.Close() } catch {} }
    # A dropped connection (browser cancelled the read, e.g. the page navigated away) is normal, not an error.
    $cancelled = $err -is [Net.HttpListenerException] -or $err -is [ObjectDisposedException]
    if ($cancelled) { $logPath += ' (cancelled by browser)' }
    @{ p = $logPath; c = $(if ($cancelled) { '---' } else { $res.StatusCode }); m = $req.HttpMethod; s = $size; ms = $sw.ElapsedMilliseconds; path = $path
       err = $(if ($err -and -not $cancelled) { $err }) }
}

# Full path of a plain static file under the root, or $null (html, missing, dot-folders, outside root).
function Get-StaticPath($rel) {
    if (-not $rel -or $rel.StartsWith('api/') -or ($rel -split '[\\/]' | Where-Object { $_.StartsWith('.') })) { return $null }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) -or $path -like '*.html' -or -not [IO.File]::Exists($path)) { return $null }
    return $path
}

function Start-StaticJob($ctx, $path, $logPath) {
    $ps = [PowerShell]::Create(); $ps.RunspacePool = $staticPool
    [void]$ps.AddScript($staticScript).AddArgument($ctx).AddArgument($path).AddArgument($logPath)
    $staticJobs.Add(@{ ps = $ps; handle = $ps.BeginInvoke() })
    $script:hits++
}

# Log finished static jobs and free them.
function Complete-StaticJobs {
    for ($i = $staticJobs.Count - 1; $i -ge 0; $i--) {
        $j = $staticJobs[$i]
        if (-not $j.handle.IsCompleted) { continue }
        try {
            $r = $j.ps.EndInvoke($j.handle) | Select-Object -Last 1
            if ($r) {
                Add-Log 'req' $r.p $r.c $r.m $r.s $r.ms
                if ($r.err) { Add-Log 'err' "File read $($r.p): $((ConvertTo-FsError $r.err $r.path 'read').Message)" }
            }
        }
        catch { Add-Log 'err' "Static file: $($_.Exception.Message)" }
        $j.ps.Dispose(); $staticJobs.RemoveAt($i)
    }
}

# --- import api (source files outside the project) ---
. (Join-Path $here 'import-api.ps1')

# --- one-time rename: data/staged -> data/imported in every project, trashed project and snapshot ---
try {
    $projRoot = Join-Path $root 'projects'
    if (Test-Path $projRoot) {
        Get-ChildItem $projRoot -Recurse -Directory -Force -Filter 'staged' | Where-Object { $_.Parent.Name -eq 'data' } | ForEach-Object {
            $to = Join-Path $_.Parent.FullName 'imported'
            if (-not (Test-Path $to)) { Rename-Item -LiteralPath $_.FullName -NewName 'imported'; Add-Log 'server' "Renamed $($_.FullName) to imported" }
        }
        Get-ChildItem $projRoot -Recurse -File -Force -Filter 'project-config.json' | ForEach-Object {
            $t = [IO.File]::ReadAllText($_.FullName)
            $n = $t -replace '/data/staged/', '/data/imported/' -replace '("stage"\s*:\s*)"staged"', '$1"imported"'
            if ($n -ne $t) { [IO.File]::WriteAllText($_.FullName, $n, (New-Object Text.UTF8Encoding $false)) }
        }
    }
} catch { Add-Log 'server' "Rename staged -> imported failed: $($_.Exception.Message)" }

# --- native data engine: C# sources in engine\, compiled by Add-Type (cached DLL), runs in this process ---
. (Join-Path $here 'engine-loader.ps1')
$engine = $null; $script:engineError = 'The data engine is not loaded; see the server log.'
try {
    $how = Load-DataEngine -Root $root
    $engine = New-DataEngine -Root $root -MaxWorkers $settings.engineWorkers -MemoryFraction $settings.engineMemory
    Add-Log 'engine' "Engine loaded ($how)."
} catch {
    $script:engineError = "Engine failed to load: $($_.Exception.Message)"
    Add-Log 'err' $script:engineError
}
# Engine log lines -> server log. 'req|METHOD|code|bytes|ms|path' lines are engine API requests.
function Read-EngineLog {
    if (-not $engine) { return }
    for ($i = 0; $i -lt 500; $i++) {
        $l = [NativeDataEngine.EngineLog]::Next()
        if ($null -eq $l) { break }
        $k, $t = $l.Split('|', 2)
        if ($k -eq 'req') { $p = $t.Split('|', 5); $script:hits++; Add-Log 'req' $p[4] ([int]$p[1]) $p[0] ([long]$p[2]) ([long]$p[3]) }
        else { Add-Log $(if ($k -eq 'err') { 'err' } else { 'engine' }) $t }
    }
}

# Returns $true if the request was handed to a background job (which closes the response itself).
# --- memory (Benchmark page memory card) ---
# Browser tab/process memory plus this server process (where the native engine runs). The process
# list (via CIM, slow) is refreshed every 5 s; memory is read fresh on each call (fast).
Add-Type -AssemblyName Microsoft.VisualBasic
$memInfo = [Microsoft.VisualBasic.Devices.ComputerInfo]::new()
$script:memProcs = @{ at = [datetime]::MinValue; renderers = @(); all = @(); source = '' }
function Update-MemProcs {
    $ps = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -Property ProcessId, ParentProcessId, CommandLine -ErrorAction SilentlyContinue)
    # Prefer the site's own browser (launched with a .profile-site-* profile); else every Edge/Chrome.
    $mains = @($ps | Where-Object { $_.CommandLine -like '*.profile-site-*' -and $_.CommandLine -notlike '*--type=*' })
    if ($mains) {
        $ids = $mains.ProcessId
        $group = @($ps | Where-Object { $_.ProcessId -in $ids -or $_.ParentProcessId -in $ids }); $src = 'site browser'
    } else { $group = $ps; $src = 'all Edge/Chrome' }
    $script:memProcs = @{ at = Get-Date; source = $src; all = @($group.ProcessId)
        renderers = @($group | Where-Object { $_.CommandLine -like '*--type=renderer*' } | ForEach-Object ProcessId) }
}
function Get-BrowserMem {
    if (((Get-Date) - $script:memProcs.at).TotalSeconds -gt 5) { Update-MemProcs }
    $tab = 0; $total = 0
    foreach ($id in $script:memProcs.all) {
        try { $m = [Diagnostics.Process]::GetProcessById($id).PrivateMemorySize64 } catch { continue }
        $total += $m
        if ($id -in $script:memProcs.renderers -and $m -gt $tab) { $tab = $m }
    }
    @{ ok = $true; tab = $tab; browser = $total; engine = [Diagnostics.Process]::GetCurrentProcess().PrivateMemorySize64; sysTotal = $memInfo.TotalPhysicalMemory; sysFree = $memInfo.AvailablePhysicalMemory; source = $script:memProcs.source }
}

function Handle-Site($req, $res, $rel, $ctx) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $static = Get-StaticPath $rel
    if ($static) { Start-StaticJob $ctx $static ("/$rel" + $req.Url.Query); return $true }
    # Cross-origin isolation: everything is same-origin; keeps pages isolated from other sites.
    $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
    $res.AddHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    $res.AddHeader('Cross-Origin-Resource-Policy', 'same-origin')
    # Native engine: checked here, answered by the engine on its own thread (it closes the response).
    if ($rel.StartsWith('api/engine/')) {
        if (-not (Test-FsRequest $req)) { $res.StatusCode = 403; Add-Log 'req' "/$rel" 403 $req.HttpMethod 0 0; return $false }
        if (-not $engine) { $res.StatusCode = 503; Send-Json $res @{ ok = $false; error = $script:engineError }; return $false }
        [NativeDataEngine.EngineApi]::Handle($engine, $ctx, $rel.Substring(11))
        return $true
    }
    # Reading source files from outside the project (import). Background jobs own their responses.
    if ($rel.StartsWith('api/import/')) {
        $op = $rel.Substring(11)
        try { if (Handle-Import $req $res $op $ctx) { return $true } }
        catch {
            $err = $_.Exception; while ($err -isnot [FsError] -and $err.InnerException) { $err = $err.InnerException }
            $err = ConvertTo-FsError $err ([string]$req.QueryString['src']) $op
            try { $res.StatusCode = $err.Code; Send-Json $res @{ ok = $false; error = $err.Message } } catch {}
            Add-Log 'err' "Import ($op): $($err.Message)"
        }
        Add-Log 'req' (Get-ImportLogPath $req) $res.StatusCode $req.HttpMethod 0 $sw.ElapsedMilliseconds
        return $false
    }
    # Light/dark toggle from the app header (the panel uses /api/settings).
    # GET: the current mode, polled every second by js/core/theme.js so every window follows a change at once (not logged).
    if ($rel -eq 'api/theme' -and $req.HttpMethod -eq 'GET') { Send-Json $res @{ ok = $true; theme = $settings.theme }; return $false }
    if ($rel -eq 'api/theme') {
        if (-not (Test-FsRequest $req) -or $req.HttpMethod -ne 'POST') { $res.StatusCode = 403; return $false }
        try { Set-Theme ([string]$req.QueryString['theme']); Send-Json $res @{ ok = $true; theme = $settings.theme } }
        catch { $res.StatusCode = 400; Send-Json $res @{ ok = $false; error = $_.Exception.Message } }
        return $false
    }
    # Server Control button (Project Manager): open the control panel, or bring it to the front.
    if ($rel -eq 'api/panel') {
        if (-not (Test-FsRequest $req) -or $req.HttpMethod -ne 'POST') { $res.StatusCode = 403; return $false }
        Open-Panel; Send-Json $res @{ ok = $true }
        return $false
    }
    # Publish module Open: a project file in its Windows app. .pptx / .pdf -> their default app, .jpg/.png -> Photos,
    # .html/.webp -> the Settings browser (normal window). POST /api/openfile?path=<project-relative path>
    if ($rel -eq 'api/openfile') {
        if (-not (Test-FsRequest $req) -or $req.HttpMethod -ne 'POST') { $res.StatusCode = 403; return $false }
        try {
            $full = Resolve-ProjectPath ([string]$req.QueryString['path'])
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'File not found.' }
            $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
            switch ($ext) {
                { $_ -in '.jpg', '.jpeg', '.png' } { Start-Process "ms-photos:viewer?fileName=$([Uri]::EscapeDataString($full))" }
                { $_ -in '.html', '.webp' } {
                    $exe = Find-Browser $settings.browser
                    if (-not $exe) { throw "$($settings.browser) is not installed." }
                    Start-Process $exe @(([Uri]$full).AbsoluteUri)
                }
                { $_ -in '.pptx', '.pdf' } { Start-Process -FilePath $full }
                default { throw "Cannot open $ext files." }
            }
            Add-Log 'sys' "Opened $([string]$req.QueryString['path'])"
            Send-Json $res @{ ok = $true }
        } catch {
            Send-Json $res @{ ok = $false; error = $_.Exception.Message }
        }
        return $false
    }
    # Project Manager closing stops the server (4 s grace so a reload, which says hello, cancels it).
    if ($rel -eq 'api/bye' -or $rel -eq 'api/hello') {
        if (-not (Test-FsRequest $req) -or $req.HttpMethod -ne 'POST') { $res.StatusCode = 403; return $false }
        $script:byeAt = if ($rel -eq 'api/bye') { (Get-Date).AddSeconds(4) } else { $null }
        Send-Json $res @{ ok = $true }
        return $false
    }
    # App shell header status, polled every 5 s: not logged. Also the app's heartbeat (main loop).
    if ($rel -eq 'api/status') {
        if (Test-FsRequest $req) {
            Send-Json $res @{ ok = $true; ps = "$($PSVersionTable.PSVersion)"; port = $settings.port; theme = $settings.theme; engine = [bool]$script:engine; user = $env:USERNAME
                              uptime = [int]((Get-Date) - $script:siteStarted).TotalSeconds }
        } else { $res.StatusCode = 403 }
        return $false
    }
    # Polled by the Benchmark page's memory card: not logged.
    if ($rel -eq 'api/mem') {
        try { if (Test-FsRequest $req) { Send-Json $res (Get-BrowserMem) } else { $res.StatusCode = 403 } } catch { $res.StatusCode = 500 }
        return $false
    }
    if ($rel -eq 'api/project/trash') {
        # Moves projects/<folder> to projects/.trash/<folder>-<time> (dot-folders are closed to the file API).
        try {
            if (-not (Test-FsRequest $req)) { throw [FsError]::new(403, 'Forbidden: request did not come from this site.') }
            if ($req.HttpMethod -ne 'POST') { throw [FsError]::new(405, 'Use POST.') }
            $folder = [string]$req.QueryString['folder']
            if ($folder -notmatch '^[a-z0-9][a-z0-9-]{0,79}$') { throw [FsError]::new(400, 'Invalid project folder.') }
            $src = Join-Path $root "projects\$folder"
            if (-not (Test-Path -LiteralPath $src -PathType Container)) { throw [FsError]::new(404, 'Project not found.') }
            $trash = Join-Path $root 'projects\.trash'
            New-Item -ItemType Directory -Force $trash | Out-Null
            $dest = Join-Path $trash ('{0}-{1:yyyyMMdd-HHmmss}' -f $folder, (Get-Date))
            Move-Item -LiteralPath $src -Destination $dest
            Add-Log 'sys' "Project '$folder' moved to projects/.trash/$(Split-Path $dest -Leaf)"
            Send-Json $res @{ ok = $true; trashed = "projects/.trash/$(Split-Path $dest -Leaf)" }
        } catch {
            $err = $_.Exception; if ($err.InnerException) { $err = $err.InnerException }
            try { $res.StatusCode = if ($err -is [FsError]) { $err.Code } else { 500 } } catch {}
            Add-Log 'err' "Project trash: $($err.Message)"
            try { Send-Json $res @{ ok = $false; error = $err.Message } } catch {}
        }
        $size = 0
    }
    elseif ($rel -in 'api/project/trash/list', 'api/project/trash/restore', 'api/project/trash/empty') {
        # Trash dialog (Project Manager): list projects/.trash, move one back to projects/<folder>, or delete everything.
        try {
            if (-not (Test-FsRequest $req)) { throw [FsError]::new(403, 'Forbidden: request did not come from this site.') }
            $trash = Join-Path $root 'projects\.trash'
            if ($rel -eq 'api/project/trash/list') {
                $items = @()
                if (Test-Path -LiteralPath $trash -PathType Container) {
                    foreach ($d in Get-ChildItem -LiteralPath $trash -Directory) {
                        $name = $d.Name
                        try { $name = (Get-Content -LiteralPath (Join-Path $d.FullName 'project-config.json') -Raw | ConvertFrom-Json).name } catch {}
                        $items += @{ id = $d.Name; name = $name; trashed = $d.LastWriteTimeUtc.ToString('o') }
                    }
                }
                Send-Json $res @{ ok = $true; items = @($items) }
            }
            else {
                if ($req.HttpMethod -ne 'POST') { throw [FsError]::new(405, 'Use POST.') }
                if ($rel -eq 'api/project/trash/empty') {
                    $n = 0
                    if (Test-Path -LiteralPath $trash -PathType Container) {
                        foreach ($d in Get-ChildItem -LiteralPath $trash -Force) { Remove-Item -LiteralPath $d.FullName -Recurse -Force; $n++ }
                    }
                    Add-Log 'sys' "Trash emptied: $n project(s) permanently deleted."
                    Send-Json $res @{ ok = $true; deleted = $n }
                }
                else {
                    $id = [string]$req.QueryString['id']
                    if ($id -notmatch '^[a-z0-9][a-z0-9-]{0,120}$') { throw [FsError]::new(400, 'Invalid trash item.') }
                    $src = Join-Path $trash $id
                    if (-not (Test-Path -LiteralPath $src -PathType Container)) { throw [FsError]::new(404, 'Not in the trash.') }
                    # <folder>-yyyyMMdd-HHmmss -> <folder>; if that name is taken again, add -restored, -restored-2, ...
                    $folder = $id -replace '-\d{8}-\d{6}$', ''
                    $dest = Join-Path $root "projects\$folder"; $k = 1
                    while (Test-Path -LiteralPath $dest) { $dest = Join-Path $root ("projects\$folder-restored" + $(if ($k -gt 1) { "-$k" } else { '' })); $k++ }
                    Move-Item -LiteralPath $src -Destination $dest
                    Add-Log 'sys' "Project restored from trash: projects/$(Split-Path $dest -Leaf)"
                    Send-Json $res @{ ok = $true; folder = (Split-Path $dest -Leaf) }
                }
            }
        } catch {
            $err = $_.Exception; if ($err.InnerException) { $err = $err.InnerException }
            try { $res.StatusCode = if ($err -is [FsError]) { $err.Code } else { 500 } } catch {}
            Add-Log 'err' "Project trash: $($err.Message)"
            try { Send-Json $res @{ ok = $false; error = $err.Message } } catch {}
        }
        $size = 0
    }
    elseif ($rel.StartsWith('api/fs/')) {
        $op = $rel.Substring(7)
        try { $size = Handle-Fs $req $res $op }
        catch {
            $err = $_.Exception
            while ($err -isnot [FsError] -and $err.InnerException) { $err = $err.InnerException }
            $q = $req.QueryString; $target = @($q['path'], $q['from'], $q['to']) -ne $null -join ' -> '
            $err = ConvertTo-FsError $err $target $op
            try { $res.StatusCode = $err.Code } catch {}
            Add-Log 'err' "File API ($op): $($err.Message)"
            try { Send-Json $res @{ ok = $false; error = $err.Message } } catch {}
            $size = 0
        }
    }
    # "/" redirects to the chosen page so its relative links (../js, ../fonts) resolve.
    elseif ($rel -eq '') { $res.Redirect("/$(Get-ShellUrl $entryPage)"); $size = 0 }
    else {
        if ($rel -eq 'favicon.ico') { $rel = 'assets/client_favicon.ico' }   # one copy of each icon, in assets
        $size = Send-File $res $root $rel -Token -req $req
        if ($size -lt 0) { $res.StatusCode = 404; $size = 0 }
    }
    $script:hits++
    # File watchers (DNFS.stat(path, { quiet: true }), e.g. D3 Studio's live code file, about 1x a second): not logged.
    if ($rel -eq 'api/fs/stat' -and $req.QueryString['quiet'] -and $res.StatusCode -eq 200) { return $false }
    Add-Log 'req' ("/$rel" + $req.Url.Query) $res.StatusCode $req.HttpMethod $size $sw.ElapsedMilliseconds
    return $false
}

# --- browsers ---
$browsers = @{
    edge   = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
}
function Find-Browser($name) { $browsers[$name] | Where-Object { Test-Path $_ } | Select-Object -First 1 }

# Opens $url as an app window: 95% of the primary screen's working-area height, 16:10 width (capped), centered.
# Each profile is its own browser process, so the size/position flags apply.
# -Width/-Height: fixed size instead (capped to the working area).
function Open-App($exe, $url, $profileName, [int]$Width = 0, [int]$Height = 0) {
    Add-Type -AssemblyName System.Windows.Forms
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $h = [int]($wa.Height * 0.95); $w = [Math]::Min([int]($h * 1.6), $wa.Width)
    if ($Width -gt 0) { $w = [Math]::Min($Width, $wa.Width); $h = [Math]::Min($Height, $wa.Height) }
    $x = $wa.X + [int](($wa.Width - $w) / 2); $y = $wa.Y + [int](($wa.Height - $h) / 2)
    # Profiles live in <root>\temp\browser (all generated data stays in the project's temp folder); flags keep them minimal (no component downloads, cache, sync, extensions).
    $dir = Join-Path $root "temp\browser\$profileName"
    # The browser remembers the last app-window size and ignores --window-size; forget it so the fixed size applies.
    $pref = Join-Path $dir 'Default\Preferences'
    if (Test-Path $pref) {
        $json = [IO.File]::ReadAllText($pref)
        $new = [regex]::Replace($json, '"app_window_placement":\{(?:[^{}]|\{[^{}]*\})*\}', '"app_window_placement":{}')
        if ($new -ne $json) { [IO.File]::WriteAllText($pref, $new) }
    }
    Start-Process $exe @("--app=$url", "--user-data-dir=`"$dir`"",
        "--window-size=$w,$h", "--window-position=$x,$y", '--no-first-run', '--no-default-browser-check',
        '--disable-component-update', '--disable-background-networking', '--disable-sync', '--disable-extensions',
        '--disable-default-apps', '--disk-cache-size=1', '--media-cache-size=1')
    return $dir
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    // Force h to the front, borrowing the current foreground window's input focus.
    public static bool Raise(IntPtr h) {
        ShowWindow(h, 9);
        IntPtr fg = GetForegroundWindow();
        uint me = GetCurrentThreadId(), fgT = GetWindowThreadProcessId(fg, IntPtr.Zero), hT = GetWindowThreadProcessId(h, IntPtr.Zero);
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
        AttachThreadInput(me, fgT, true); AttachThreadInput(hT, fgT, true);
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 3);
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 3);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        AttachThreadInput(hT, fgT, false); AttachThreadInput(me, fgT, false);
        return GetForegroundWindow() == h;
    }
}
"@

# Brings the browser window using profile $dir to the front. Waits up to 8s for it
# to appear, then keeps raising until it is the foreground window and stays there.
function Raise-Window($dir) {
    $exeName = 'msedge.exe', 'chrome.exe'
    $wins = 0
    for ($n = 0; $n -lt 40; $n++) {
        Start-Sleep -Milliseconds 200
        $ids = @(Get-CimInstance Win32_Process | Where-Object { $exeName -contains $_.Name -and $_.CommandLine -like "*$dir*" } | ForEach-Object ProcessId)
        if (-not $ids) { continue }
        $p = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $p -or -not [Win]::IsWindowVisible($p.MainWindowHandle)) { continue }
        if ([Win]::Raise($p.MainWindowHandle)) { $wins++ } else { $wins = 0 }
        if ($wins -ge 3) { return }
    }
}

# --- control panel: opened on demand (Server Control button in the Project Manager) ---
$uiUrl = "http://localhost:$uiPort/"
$browser = (Find-Browser 'edge'), (Find-Browser 'chrome') | Where-Object { $_ } | Select-Object -First 1
$script:panelBeat = $null
function Open-Panel {
    $dir = Join-Path $root 'temp\browser\.profile'
    if ($script:panelBeat -and ((Get-Date) - $script:panelBeat).TotalSeconds -lt 5) { Raise-Window "$dir`"" }   # already open
    elseif ($browser) { Open-App $browser $uiUrl '.profile' -Width 1200 -Height 800 | Out-Null }
    else { Start-Process $uiUrl }
}

# --- start the site and open the app (Project Manager) ---
if (Test-Path (Join-Path $root $entryPage) -PathType Leaf) {
    try { Start-Site; Open-Site | Out-Null } catch { Add-Log 'err' "Start failed: $($_.Exception.Message)" }
} else { Add-Log 'err' "$entryPage not found." }

# --- main loop ---
# Closing the Project Manager stops the server (/api/bye). Heartbeats: the panel's log poll (1 s) and every app window's status poll (5 s). The server exits
# 120 s after the last one (all windows closed), or 60 s after start if none ever connects.
$script:running = $true
$script:byeAt = $null
$lastBeat = $null
$deadline = (Get-Date).AddSeconds(60)
$pending = $listener.GetContextAsync()
$script:loadMs = $startSw.ElapsedMilliseconds
try {
    while ($script:running) {
        # Poll faster while background file jobs are running so their log lines appear promptly.
        if ($pending.Wait($(if ($staticJobs.Count -or $importJobs.Count) { 10 } else { 250 }))) {
            $ctx = $pending.Result
            $pending = $listener.GetContextAsync()
            $req = $ctx.Request; $res = $ctx.Response
            $async = $false
            try {
                $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
                if ($req.Url.Port -eq $uiPort) {
                    if ($rel -eq 'api/log') { $lastBeat = $script:panelBeat = Get-Date }
                    Handle-Ui $req $res $rel
                } else {
                    if ($rel -eq 'api/status') { $lastBeat = Get-Date }
                    $async = Handle-Site $req $res $rel $ctx
                }
            } catch {
                try { $res.StatusCode = 500 } catch {}
                Add-Log 'err' "$($req.HttpMethod) /$rel : $($_.Exception.Message)"
            } finally {
                if (-not $async) { try { $res.Close() } catch {} }
            }
        }
        if ($staticJobs.Count) { Complete-StaticJobs }
        Read-EngineLog
        if ($importJobs.Count) { Watch-ImportJobs }
        $now = Get-Date
        if ($script:byeAt -and $now -gt $script:byeAt) { break }   # Project Manager closed
        if ($lastBeat -and ($now - $lastBeat).TotalSeconds -gt 120) { break }   # throttled/minimized tabs poll slowly
        if (-not $lastBeat -and $now -gt $deadline) { break }
    }
} catch {
    Add-Log 'err' "Fatal: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
    Add-Log 'sys' 'Server stopped.'
    try { if ($engine) { $engine.Dispose() } } catch {}
    try { $staticPool.Close(); $staticPool.Dispose() } catch {}
    try { $importPool.Close(); $importPool.Dispose() } catch {}
    $listener.Stop()
    $listener.Close()
    if ((Get-Content $pidFile -ErrorAction SilentlyContinue) -eq "$PID") { Remove-Item $pidFile -ErrorAction SilentlyContinue }
}
