# ONE-TIME move of the music library from the OneDrive mount (M:) to the server's own disk.
# Run in an ADMIN PowerShell on the server:   C:\Musicbox\app\deploy\windows-server\migrate-to-local.ps1
#
# What it does:
#   1. stops the app and the OneDrive mount (so the copy reads straight from OneDrive)
#   2. copies every song from OneDrive to C:\Musicbox\library and checks the count/size match
#   3. points the app at the new folder (.env LIBRARY_DIR; the old .env is kept as .env.bak)
#   4. turns off the M: mount and starts Musicbox-Sync, which backs the library up to OneDrive
#   5. starts the app again
# Safe to re-run: files already copied are skipped, and nothing in OneDrive is deleted or changed.
# Developed by Prime Computers.
param([string]$Library = 'C:\Musicbox\library')

$ErrorActionPreference = 'Stop'
$Root    = 'C:\Musicbox'
$App     = "$Root\app"
$Rclone  = "$Root\rclone.exe"
$Conf    = "$Root\rclone.conf"
$Remote  = 'musicbox:Narendras musicbox'
$NodeDir = 'C:\Program Files\nodejs'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   ok  $m" -ForegroundColor Green }
function Info($m) { Write-Host "       $m" }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
    throw 'Run this in PowerShell opened with "Run as administrator".'
}
if (-not (Test-Path "$App\deploy\windows-server\run-sync.ps1")) {
    throw "run-sync.ps1 is not on the server yet - wait a few minutes for the auto-update to deploy, then run this again."
}

Step 'Stopping the app and the OneDrive mount'
foreach ($t in 'Musicbox-App', 'Musicbox-Mount') { if (Get-ScheduledTask $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask $t } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*server\index.js*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process rclone -ErrorAction SilentlyContinue | Where-Object Path -eq $Rclone | Stop-Process -Force
Start-Sleep -Seconds 3
Ok 'stopped'

Step 'Checking OneDrive and disk space'
$remoteSize = & $Rclone size $Remote --json --config $Conf | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $null -eq $remoteSize) { throw 'Could not read OneDrive - is the rclone login valid? (rclone config reconnect musicbox:)' }
$driveName = (Split-Path -Qualifier $Library).TrimEnd(':')
$freeGB = (Get-PSDrive $driveName).Free / 1GB
$needGB = $remoteSize.bytes / 1GB
Info ("OneDrive: {0} files, {1:N2} GB.  Free on {2}: {3:N1} GB" -f $remoteSize.count, $needGB, "${driveName}:", $freeGB)
if ($freeGB -lt ($needGB * 1.3 + 2)) { throw 'Not enough free disk space for the library plus a safety margin.' }
Ok 'enough space'

Step 'Copying the library from OneDrive (this can take a while)'
New-Item -ItemType Directory -Force $Library | Out-Null
& $Rclone copy $Remote $Library --config $Conf --transfers 4 --progress --log-file "$Root\logs\migrate.log" --log-level INFO
if ($LASTEXITCODE -ne 0) { throw "Copy failed - see $Root\logs\migrate.log. Run this script again to resume." }
$localSize = & $Rclone size $Library --json | ConvertFrom-Json
Info ("Local: {0} files, {1:N2} GB" -f $localSize.count, ($localSize.bytes / 1GB))
if ($localSize.count -ne $remoteSize.count -or $localSize.bytes -ne $remoteSize.bytes) {
    throw 'The local copy does not match OneDrive (file count or size). Nothing was changed - run this script again.'
}
Ok 'local copy matches OneDrive'

Step 'Pointing the app at the new folder'
Copy-Item "$App\.env" "$App\.env.bak" -Force
$lines = Get-Content "$App\.env" | Where-Object { $_ -notmatch '^LIBRARY_DIR=' }
$lines + "LIBRARY_DIR=$Library" | Set-Content "$App\.env" -Encoding ascii
Ok "LIBRARY_DIR=$Library"

Step 'Turning off the M: mount and starting the OneDrive backup'
if (Get-ScheduledTask 'Musicbox-Mount' -ErrorAction SilentlyContinue) { Disable-ScheduledTask 'Musicbox-Mount' | Out-Null }
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$App\deploy\windows-server\run-sync.ps1`" -Library `"$Library`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Musicbox-Sync' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Ok 'backup task Musicbox-Sync registered (every 15 minutes)'

Step 'Starting the app'
Start-ScheduledTask 'Musicbox-App'
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest 'http://127.0.0.1:4300/api/me' -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $up = $_.Exception.Response.StatusCode.value__ -eq 401 }
}
if (-not $up) { throw "App did not start - see $Root\logs\app-error.log. (Your old settings are in $App\.env.bak)" }
Ok 'app is running'

Write-Host "`nDone. Open the app's Health check page: it should show all songs found." -ForegroundColor Cyan
Write-Host 'The M: drive is no longer used. Songs now play from ' -NoNewline; Write-Host $Library -ForegroundColor Yellow
