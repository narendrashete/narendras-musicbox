# Keeps OneDrive:"Narendras musicbox" mounted as drive M: for the app (runs as SYSTEM at startup).
# Songs are fetched from OneDrive only when played; the local cache is capped so C: doesn't fill up.
# Developed by Prime Computers.
$Root = 'C:\Musicbox'
while ($true) {
    & "$Root\rclone.exe" mount 'musicbox:Narendras musicbox' M: `
        --config "$Root\rclone.conf" `
        --volname Musicbox `
        --vfs-cache-mode full --vfs-cache-max-size 3G --vfs-cache-max-age 24h --cache-dir "$Root\cache" `
        --dir-cache-time 5m --poll-interval 1m `
        --log-file "$Root\logs\mount.log" --log-level NOTICE --no-console
    Start-Sleep -Seconds 10   # rclone exited (network blip, token refresh failure...) - try again
}
