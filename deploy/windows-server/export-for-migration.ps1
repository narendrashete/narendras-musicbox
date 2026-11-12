# One-time handover to the Linux server (prime-dev). Stops and disables every Musicbox task here so
# nothing changes after the copy, then copies the database, the songs, .env and rclone.conf to -To.
# Default -To is the D: drive of the PC you're connected from: in Remote Desktop, tick
# Show Options > Local Resources > More... > Drives before connecting.
# Run in an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\Musicbox\app\deploy\windows-server\export-for-migration.ps1
# To undo (go back to this server): Enable-ScheduledTask + Start-ScheduledTask on the same tasks.
# Developed by Prime Computers.
param([string]$To = '\\tsclient\D\musicbox-migration')

$ErrorActionPreference = 'Stop'
$Root = 'C:\Musicbox'
$parent = Split-Path $To
if (-not (Test-Path $parent)) { throw "$parent isn't reachable. Reconnect Remote Desktop with your PC's drives shared (Local Resources > More... > Drives)." }

foreach ($t in 'Musicbox-Update', 'Musicbox-Sync', 'Musicbox-App', 'Musicbox-Mount') {
    if (Get-ScheduledTask $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask $t; Disable-ScheduledTask $t | Out-Null; "stopped + disabled $t"
    }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*server\index.js*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Force $To | Out-Null
foreach ($d in 'data', 'library') {
    "copying $d ..."
    & robocopy "$Root\$d" "$To\$d" /MIR /R:2 /W:5 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copy of $d failed (robocopy $LASTEXITCODE)" }
}
Copy-Item "$Root\app\.env" "$To\env.txt" -Force
if (Test-Path "$Root\rclone.conf") { Copy-Item "$Root\rclone.conf" "$To\rclone.conf" -Force }

$files = Get-ChildItem $To -Recurse -File
"Done: $($files.Count) files, $([math]::Round(($files | Measure-Object Length -Sum).Sum / 1GB, 2)) GB in $To"
"The app is now OFF on this server. Tell Claude the copy is done."
