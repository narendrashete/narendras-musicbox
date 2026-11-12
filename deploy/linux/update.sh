#!/usr/bin/env bash
# Auto-deploy: runs every 5 minutes as root (musicbox-update.timer). Deploys the newest commit on main
# once its GitHub Actions checks have passed. Pull-based: the server only makes outbound HTTPS calls to
# GitHub - no inbound ports and no GitHub runner on this machine (the repo is public, so a runner here
# would let fork PRs run code on the server). Rolls back if the new version doesn't come up.
# Everything is inside main(), which bash reads in full before running, so replacing this file
# during a deploy is safe.
# Developed by Prime Computers.

main() {
  set -uo pipefail
  local REPO=narendrashete/narendras-musicbox BRANCH=main
  local ROOT=/srv/musicbox
  local APP=$ROOT/app STATE=$ROOT/deployed.txt SKIP=$ROOT/failed.txt LOG=$ROOT/logs/update.log WORK=$ROOT/releases
  local API=(-fsSL -H 'User-Agent: musicbox-updater' -H 'Accept: application/vnd.github+json')
  exec 9> /run/musicbox-update.lock
  flock -n 9 || return   # a deploy is already running
  log() { echo "$(date '+%F %T')  $*" >> "$LOG"; }
  app_ok() {
    for _ in $(seq 30); do
      sleep 2
      [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4300/api/me)" = 401 ] && return 0
    done
    return 1
  }
  # Mirror a prepared release (with its node_modules) into the app folder, keeping the server's .env.
  install_release() { rsync -a --delete --exclude .env --exclude initial-data "$1"/ "$APP"/; }

  local sha live failed runs
  sha=$(curl "${API[@]}" "https://api.github.com/repos/$REPO/commits/$BRANCH" | jq -r .sha) || { log "error: can't reach GitHub"; return; }
  live=$(cat "$STATE" 2>/dev/null || true)
  failed=$(cat "$SKIP" 2>/dev/null || true)
  if [ "$sha" = "$live" ] || [ "$sha" = "$failed" ]; then return; fi

  runs=$(curl "${API[@]}" "https://api.github.com/repos/$REPO/commits/$sha/check-runs") || return
  [ "$(jq '.check_runs | length' <<<"$runs")" -gt 0 ] || return                                     # CI not started yet
  [ "$(jq '[.check_runs[] | select(.status != "completed")] | length' <<<"$runs")" = 0 ] || return   # still running
  if [ "$(jq '[.check_runs[] | select(.conclusion | IN("success","skipped","neutral") | not)] | length' <<<"$runs")" != 0 ]; then
    log "skip ${sha:0:7}: CI failed"; echo "$sha" > "$SKIP"; return
  fi

  log "deploying ${sha:0:7} (live: ${live:0:7})"
  rm -rf "$WORK"; mkdir -p "$WORK/new"
  if ! curl "${API[@]}" "https://api.github.com/repos/$REPO/tarball/$sha" | tar -xz -C "$WORK/new" --strip-components=1; then
    log "error: download of ${sha:0:7} failed"; return
  fi
  chown -R musicbox:musicbox "$WORK"
  # Install packages before stopping anything, so the app is only down for the swap itself.
  if ! (cd "$WORK/new" && runuser -u musicbox -- env HOME="$ROOT" npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
    log "FAILED ${sha:0:7}: npm ci - still on ${live:0:7}"; echo "$sha" > "$SKIP"; return
  fi
  rsync -a --delete "$APP"/ "$WORK/prev"/   # current version, for rollback

  systemctl stop musicbox
  install_release "$WORK/new"
  systemctl start musicbox
  if app_ok; then
    echo "$sha" > "$STATE"; rm -f "$SKIP"; log "live: ${sha:0:7}"
  else
    log "FAILED ${sha:0:7}: new version did not start - rolling back"
    systemctl stop musicbox
    install_release "$WORK/prev"
    systemctl start musicbox
    if app_ok; then log "rollback ok"; else log "rollback ALSO FAILED - see: journalctl -u musicbox"; fi
    echo "$sha" > "$SKIP"
  fi
}
main "$@"; exit
