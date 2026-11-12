#!/usr/bin/env bash
# Backs the music library up to OneDrive: copies new/changed songs from /srv/musicbox/library to the
# OneDrive folder. Copy only - it never deletes anything in OneDrive. Runs as user musicbox every
# 15 minutes (musicbox-backup.timer). Writes logs/sync-status.json, which the Health check page reads.
# Developed by Prime Computers.
set -uo pipefail
ROOT=/srv/musicbox
LOG=$ROOT/logs/sync.log
STATUS=$ROOT/logs/sync-status.json

if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi

rclone copy "$ROOT/library" 'musicbox:Narendras musicbox' --config "$ROOT/rclone.conf" \
  --transfers 2 --stats 0 --log-file "$LOG" --log-level NOTICE
code=$?

err=''
if [ "$code" -ne 0 ]; then err=$(tail -n 60 "$LOG" 2>/dev/null | grep -E 'ERROR|CRITICAL' | tail -n 1 | cut -c1-400); fi
jq -n --arg time "$(date -u +%FT%TZ)" --argjson code "$code" --arg error "$err" \
  '{time: $time, ok: ($code == 0), exitCode: $code, error: $error}' > "$STATUS"
