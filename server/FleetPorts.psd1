# Data Noodler's line from the edge-ops port registry (PORTS.md, approved 2026-10-25).
# The site port is exempt: manual (default 47823) or random in 30000-46999 (server.ps1 Get-RandomPort).
@{
    'data-noodler' = @{ Start = 8079; Size = 3; Policy = 'reuse' }
}
