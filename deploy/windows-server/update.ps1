# Auto-deploy: runs every 5 minutes as SYSTEM (task Musicbox-Update). Deploys the newest commit on
# main once its GitHub Actions checks have passed. Pull-based: the server only makes outbound HTTPS
# calls to GitHub - no inbound ports and no GitHub runner on this machine.
# Rolls back to the previous version if the new one doesn't come up.
# Developed by Prime Computers.
param([string]$Repo = 'narendrashete/narendras-musicbox', [string]$Branch = 'main')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root     = 'C:\Musicbox'
$App      = "$Root\app"
$NodeDir  = 'C:\Program Files\nodejs'
$StateF   = "$Root\deployed.txt"      # sha currently live
$SkipF    = "$Root\failed.txt"        # last sha that failed, so it isn't retried every 5 minutes
$Log      = "$Root\logs\update.log"
$Api      = @{ 'User-Agent' = 'musicbox-updater'; Accept = 'application/vnd.github+json' }

function Write-Log($m) { Add-Content $Log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
function Test-App {
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try { Invoke-WebRequest 'http://127.0.0.1:4300/api/me' -UseBasicParsing -TimeoutSec 5 | Out-Null }
        catch { if ($_.Exception.Response.StatusCode.value__ -eq 401) { return $true } }
    }
    return $false
}
function Stop-App {
    Stop-ScheduledTask 'Musicbox-App'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*server\index.js*' |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}
# Mirror a release into C:\Musicbox\app, keeping the server-only bits (.env, installed packages).
function Install-Release($src) {
    & robocopy $src $App /MIR /XF .env /XD node_modules initial-data /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    Push-Location $App
    # npm writes "npm notice ..." lines to stderr even when it succeeds; with 'Stop' PowerShell 5.1
    # turns those into a thrown error, so judge npm by its exit code only.
    $ErrorActionPreference = 'Continue'
    try { & "$NodeDir\npm.cmd" ci --omit=dev --no-audit --no-fund 2>&1 | Out-Null; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }
}

try {
    $sha = (Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $Api).sha
    $live = if (Test-Path $StateF) { (Get-Content $StateF -Raw).Trim() } else { '' }
    if ($sha -eq $live -or ($sha -eq ((Get-Content $SkipF -Raw -ErrorAction SilentlyContinue) + '').Trim())) { return }

    $runs = (Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$sha/check-runs" -Headers $Api).check_runs
    if (-not $runs -or ($runs | Where-Object status -ne 'completed')) { return }   # CI still running - next time
    if ($runs | Where-Object { $_.conclusion -notin 'success', 'skipped', 'neutral' }) {
        Write-Log "skip $($sha.Substring(0,7)): CI failed"; Set-Content $SkipF $sha; return
    }

    Write-Log "deploying $($sha.Substring(0,7)) (live: $(if ($live) { $live.Substring(0,7) } else { 'unknown' }))"
    $work = "$Root\releases"
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $work | Out-Null
    Invoke-WebRequest "https://api.github.com/repos/$Repo/zipball/$sha" -Headers $Api -OutFile "$work\new.zip" -UseBasicParsing
    Expand-Archive "$work\new.zip" "$work\new"
    $new = (Get-ChildItem "$work\new" -Directory | Select-Object -First 1).FullName

    # Keep a copy of the current version for rollback.
    & robocopy $App "$work\prev" /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null

    Stop-App
    try {
        Install-Release $new
        Start-ScheduledTask 'Musicbox-App'
        if (-not (Test-App)) { throw 'new version did not start' }
    } catch {
        Write-Log "FAILED $($sha.Substring(0,7)): $_ - rolling back"
        Stop-App
        Install-Release "$work\prev"
        Start-ScheduledTask 'Musicbox-App'
        Write-Log ("rollback " + $(if (Test-App) { 'ok' } else { 'ALSO FAILED - check logs\app-error.log' }))
        Set-Content $SkipF $sha
        return
    }
    Set-Content $StateF $sha
    Remove-Item $SkipF -ErrorAction SilentlyContinue
    Write-Log "live: $($sha.Substring(0,7))"
} catch {
    Write-Log "error: $_"
}
