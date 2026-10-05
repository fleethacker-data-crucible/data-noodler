# Import API: read source files from OUTSIDE the project (local or network drives), read-only.
# Dot-sourced by server.ps1. Writes only ever go inside the project (Resolve-ProjectPath).
#
#   GET  /api/import/probe?src=<full path>           { exists, size, modified, readable }
#   GET  /api/import/read?src=<full path>&t=<token>  streams the file (Range + HEAD) so DuckDB can read it in place
#   POST /api/import/copy?src=<full path>&to=<project path>&id=<job id>
#                                                    copies into the project in 4 MB chunks, checks the size: { path, size }
#   GET  /api/import/progress?id=<job id>            { done, total } of a running copy
#
# Every call runs on a background runspace, so a dead network drive can't freeze the server.
# The main loop watches each job (Watch-ImportJobs): no progress for 10 s -> warning naming the drive,
# 30 s -> gives up with a 504 and tells the user where to check or what to copy by hand.

$importWarnSec = 10
$importTimeoutSec = 30
# Data file types the import API will read. Anything else is refused.
$importExts = '.csv', '.tsv', '.txt', '.parquet', '.pq', '.sqlite', '.sqlite3', '.db'

# A full source path (X:\... or \\server\share\...), or throws FsError.
function Resolve-SourcePath([string]$src) {
    if (-not $src) { throw [FsError]::new(400, 'Source path required.') }
    $src = $src.Trim().Trim('"') -replace '/', '\'
    if ($src -match '^\\\\[?.]\\') { throw [FsError]::new(403, 'Device paths are not allowed.') }
    if ($src -notmatch '^[A-Za-z]:\\' -and $src -notmatch '^\\\\[^\\]+\\[^\\]+\\') {
        throw [FsError]::new(400, "Source must be a full path like X:\folder\file.csv or \\server\share\file.csv (got '$src').")
    }
    $full = [IO.Path]::GetFullPath($src)
    if ([IO.Path]::GetExtension($full).ToLower() -notin $importExts) {
        throw [FsError]::new(415, "Not a supported data file ($($importExts -join ', ')): $full")
    }
    # The project's own dot-folders (.server, .git, .trash) stay closed.
    if ($full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) -and
        ($full.Substring($root.Length + 1) -split '\\' | Where-Object { $_.StartsWith('.') })) {
        throw [FsError]::new(403, 'Access to project dot-folders is not allowed.')
    }
    return $full
}

# Like Test-FsRequest, but the token may also come as ?t= (DuckDB's HTTP reader can't send headers).
function Test-ImportRequest($req) {
    $hostOk = $req.Headers['Host'] -in "localhost:$($settings.port)", "127.0.0.1:$($settings.port)"
    $origin = $req.Headers['Origin']
    $originOk = -not $origin -or $origin -in "http://localhost:$($settings.port)", "http://127.0.0.1:$($settings.port)"
    $tokenOk = $req.Headers['X-DN-Token'] -eq $fsToken -or $req.QueryString['t'] -eq $fsToken
    return $hostOk -and $originOk -and $tokenOk
}

# Background job. Writes the success response itself; on error it returns the exception and leaves
# the response to the main thread (which turns it into a plain-English message).
# $prog is shared with the main thread: at (last progress), done/total (bytes), claimed (response owner).
$importScript = {
    param($ctx, $op, $src, $dest, $prog)
    $res = $ctx.Response; $req = $ctx.Request
    # Exactly one side (this job, or the main thread on timeout) writes the response.
    function Claim { [Threading.Monitor]::Enter($prog.SyncRoot); try { if ($prog.claimed) { $false } else { $prog.claimed = $true; $true } } finally { [Threading.Monitor]::Exit($prog.SyncRoot) } }
    function Reply($obj) {
        if (-not (Claim)) { return }
        $b = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $obj -Compress))
        $res.ContentType = 'application/json'; $res.ContentLength64 = $b.Length
        $res.OutputStream.Write($b, 0, $b.Length); $res.Close()
    }
    try {
        switch ($op) {
            'probe' {
                $fi = [IO.FileInfo]::new($src)
                if (-not $fi.Exists) {
                    # Tell "file missing" apart from "folder missing" and "drive gone" (main thread names it).
                    if (-not [IO.Directory]::Exists($fi.DirectoryName)) { throw [IO.DirectoryNotFoundException]::new("Folder not found: $($fi.DirectoryName)") }
                    throw [IO.FileNotFoundException]::new("File not found: $src")
                }
                $fs = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
                try { [void]$fs.ReadByte() } finally { $fs.Dispose() }   # proves it is readable
                $prog.at = [DateTime]::UtcNow
                Reply @{ ok = $true; exists = $true; readable = $true; size = $fi.Length; modified = $fi.LastWriteTimeUtc.ToString('o') }
                return @{ size = 0 }
            }
            'read' {
                [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite').Dispose()   # fail here (unclaimed) if unreadable
                $prog.at = [DateTime]::UtcNow
                if (-not (Claim)) { return @{ size = 0 } }
                $res.AddHeader('Cross-Origin-Resource-Policy', 'same-origin')
                $n = Send-Stream $res $src $req $prog
                $res.Close()
                return @{ size = $n }
            }
            'copy' {
                $in = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
                try {
                    $prog.total = $in.Length; $prog.at = [DateTime]::UtcNow
                    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
                    $tmp = "$dest.part"
                    $out = [IO.File]::Create($tmp)
                    try {
                        $buf = [byte[]]::new(4MB)
                        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                            $out.Write($buf, 0, $n)
                            $prog.done += $n; $prog.at = [DateTime]::UtcNow
                            if ($prog.cancel) { throw [OperationCanceledException]::new('Copy cancelled (drive stopped responding).') }
                        }
                    } finally { $out.Dispose() }
                } catch { Remove-Item -LiteralPath "$dest.part" -Force -ErrorAction SilentlyContinue; throw }
                finally { $in.Dispose() }
                $got = ([IO.FileInfo]::new($tmp)).Length
                if ($got -ne $prog.total) {
                    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                    throw [IO.IOException]::new("Copy incomplete: got $got of $($prog.total) bytes.")
                }
                Move-Item -LiteralPath $tmp -Destination $dest -Force
                Reply @{ ok = $true; size = $got }
                return @{ size = $got }
            }
        }
    } catch {
        $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
        if ($op -eq 'read' -and $prog.claimed) { try { $res.Abort() } catch {} }   # failed mid-stream
        return @{ err = $e }
    }
}

$importIss = [Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$importIss.Commands.Add([Management.Automation.Runspaces.SessionStateFunctionEntry]::new('Send-Stream', ${function:Send-Stream}.ToString()))
$importIss.Variables.Add([Management.Automation.Runspaces.SessionStateVariableEntry]::new('mime', $mime, ''))
$importPool = [RunspaceFactory]::CreateRunspacePool(1, 8, $importIss, $Host)
$importPool.Open()
$importJobs = [Collections.Generic.List[object]]::new()
$importProg = @{}   # job id -> $prog, for /api/import/progress

# Path without the token, for the log.
function Get-ImportLogPath($req) { ("/$($req.Url.AbsolutePath.TrimStart('/'))" + ($req.Url.Query -replace '([?&])t=[^&]*&?', '$1')).TrimEnd('?', '&') }

# Handles /api/import/<op>. Returns $true when a background job owns the response.
function Handle-Import($req, $res, $op, $ctx) {
    if (-not (Test-ImportRequest $req)) { throw [FsError]::new(403, 'Forbidden: request did not come from this site.') }
    $q = $req.QueryString
    if ($op -eq 'progress') {
        $p = $importProg[[string]$q['id']]
        Send-Json $res $(if ($p) { @{ ok = $true; done = $p.done; total = $p.total } } else { @{ ok = $false; error = 'No such job.' } })
        return $false
    }
    if ($op -notin 'probe', 'read', 'copy') { throw [FsError]::new(404, "Unknown import call '$op'.") }
    $src = Resolve-SourcePath $q['src']
    $dest = $null
    if ($op -eq 'copy') {
        if ($req.HttpMethod -ne 'POST') { throw [FsError]::new(405, 'Use POST.') }
        $dest = Resolve-ProjectPath $q['to']
        if ((Test-Path -LiteralPath $dest) -and $q['overwrite'] -ne '1') { throw [FsError]::new(409, 'Destination exists. Pass overwrite=1.') }
    }
    $prog = [hashtable]::Synchronized(@{ at = [DateTime]::UtcNow; done = 0; total = 0; claimed = $false; cancel = $false })
    $id = if ($q['id']) { [string]$q['id'] } else { [Guid]::NewGuid().ToString('N') }
    $importProg[$id] = $prog
    $ps = [PowerShell]::Create(); $ps.RunspacePool = $importPool
    [void]$ps.AddScript($importScript).AddArgument($ctx).AddArgument($op).AddArgument($src).AddArgument($dest).AddArgument($prog)
    $importJobs.Add(@{ ps = $ps; handle = $ps.BeginInvoke(); ctx = $ctx; op = $op; src = $src; id = $id; prog = $prog
                       started = Get-Date; warned = $false; abandoned = $false; logPath = (Get-ImportLogPath $req) })
    $script:hits++
    if ($op -ne 'read') { Add-Log 'sys' "Import $op started: $src" }
    return $true
}

# Main thread: write the response if the job didn't (claims it), as JSON { ok:false, error }.
function Send-ImportError($job, $fsErr) {
    $p = $job.prog
    [Threading.Monitor]::Enter($p.SyncRoot)
    try { if ($p.claimed) { return }; $p.claimed = $true } finally { [Threading.Monitor]::Exit($p.SyncRoot) }
    $res = $job.ctx.Response
    try { $res.StatusCode = $fsErr.Code; Send-Json $res @{ ok = $false; error = $fsErr.Message; drive = (Get-DriveName $job.src) } } catch {}
    try { $res.Close() } catch {}
}

# Called every loop pass: finish done jobs, warn on stalls, give up on dead drives.
function Watch-ImportJobs {
    $now = [DateTime]::UtcNow
    for ($i = $importJobs.Count - 1; $i -ge 0; $i--) {
        $j = $importJobs[$i]
        if ($j.handle.IsCompleted) {
            if (-not $j.abandoned) {
                $r = $null
                try { $r = $j.ps.EndInvoke($j.handle) | Select-Object -Last 1 } catch { $r = @{ err = $_.Exception } }
                $ms = [int]((Get-Date) - $j.started).TotalMilliseconds
                if ($r.err) {
                    $f = ConvertTo-FsError $r.err $j.src $(if ($j.op -eq 'copy') { 'copy' } else { 'read' })
                    $hint = if ($f.Code -in 503, 504) { ' Check the drive, or copy the file manually into the project''s temp or source folder.' } else { '' }
                    $f = [FsError]::new($f.Code, $f.Message + $hint)
                    Send-ImportError $j $f
                    Add-Log 'req' $j.logPath $f.Code $j.ctx.Request.HttpMethod 0 $ms
                    Add-Log 'err' "Import $($j.op): $($f.Message)"
                } else {
                    Add-Log 'req' $j.logPath $j.ctx.Response.StatusCode $j.ctx.Request.HttpMethod $r.size $ms
                    if ($j.op -eq 'copy') { Add-Log 'sys' "Import copy done ($([Math]::Round($r.size / 1MB, 1)) MB, $([Math]::Round($ms / 1000, 1)) s): $($j.src)" }
                }
            }
            try { $j.ps.Dispose() } catch {}
            $importProg.Remove($j.id); $importJobs.RemoveAt($i)
            continue
        }
        if ($j.abandoned) { continue }
        $stall = ($now - $j.prog.at).TotalSeconds
        $drive = Get-DriveName $j.src
        if ($stall -ge $importTimeoutSec) {
            $j.abandoned = $true; $j.prog.cancel = $true
            $f = [FsError]::new(504, "Drive $drive did not respond for $importTimeoutSec s; gave up on $($j.src). Check the connection, or copy the file manually into the project's temp or source folder.")
            if ($j.prog.claimed) { try { $j.ctx.Response.Abort() } catch {} } else { Send-ImportError $j $f }
            Add-Log 'req' $j.logPath 504 $j.ctx.Request.HttpMethod 0 ([int]((Get-Date) - $j.started).TotalMilliseconds)
            Add-Log 'err' "Import $($j.op): $($f.Message)"
            try { [void]$j.ps.BeginStop($null, $null) } catch {}
        } elseif ($stall -ge $importWarnSec -and -not $j.warned) {
            $j.warned = $true
            Add-Log 'warn' "Waiting on drive ${drive}: no response for $importWarnSec s ($($j.src)). Giving up at $importTimeoutSec s."
        }
    }
}
