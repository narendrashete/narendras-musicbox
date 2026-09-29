# Runs the Musicbox Node server on 127.0.0.1:4300 (runs as SYSTEM at startup; IIS proxies to it).
# Developed by Prime Computers.
$Root = 'C:\Musicbox'
$Node = 'C:\Program Files\nodejs\node.exe'
while ($true) {
    # Wait for the OneDrive mount so the startup scan sees the library.
    for ($i = 0; $i -lt 60 -and -not (Test-Path 'M:\'); $i++) { Start-Sleep -Seconds 3 }
    foreach ($f in 'app.log', 'app-error.log') {
        if (Test-Path "$Root\logs\$f") { Move-Item "$Root\logs\$f" "$Root\logs\$f.1" -Force }
    }
    Start-Process -FilePath $Node -ArgumentList 'server\index.js' -WorkingDirectory "$Root\app" -NoNewWindow -Wait `
        -RedirectStandardOutput "$Root\logs\app.log" -RedirectStandardError "$Root\logs\app-error.log"
    Start-Sleep -Seconds 5
}
