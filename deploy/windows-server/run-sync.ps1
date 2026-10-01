# Backs the music library up to OneDrive: copies new/changed songs from C:\Musicbox\library to the
# OneDrive folder. Copy only - it never deletes anything in OneDrive. Runs as SYSTEM every 15 minutes
# (task Musicbox-Sync). Writes logs\sync-status.json, which the app's Health check page reads.
# Developed by Prime Computers.
param([string]$Library = 'C:\Musicbox\library')

$Root   = 'C:\Musicbox'
$Rclone = "$Root\rclone.exe"
$Conf   = "$Root\rclone.conf"
$Remote = 'musicbox:Narendras musicbox'
$Log    = "$Root\logs\sync.log"
$Status = "$Root\logs\sync-status.json"

if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 5MB) { Move-Item $Log "$Log.1" -Force }

& $Rclone copy $Library $Remote --config $Conf --transfers 2 --stats 0 --log-file $Log --log-level NOTICE
$code = $LASTEXITCODE

$err = ''
if ($code -ne 0 -and (Test-Path $Log)) {
    $line = Get-Content $Log -Tail 60 | Where-Object { $_ -match 'ERROR|CRITICAL' } | Select-Object -Last 1
    if ($line) { $err = [string]$line }
    if ($err.Length -gt 400) { $err = $err.Substring(0, 400) }
}
@{ time = (Get-Date).ToUniversalTime().ToString('o'); ok = ($code -eq 0); exitCode = $code; error = $err } |
    ConvertTo-Json | Set-Content $Status -Encoding ascii
