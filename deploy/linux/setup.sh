#!/usr/bin/env bash
# Installs Narendra's Musicbox on an Ubuntu 24.04 box that already runs Caddy (prime-dev).
# Usage (as root):  bash setup.sh "musicbox.narendrashete.com"
# The argument is the Caddy site address (comma-separate several hostnames).
# Safe to re-run: it never touches data/, library/, rclone.conf or an existing .env.
# Developed by Prime Computers.
set -euo pipefail
SITE=${1:?usage: setup.sh "<hostname>[, <hostname>...]"}
ROOT=/srv/musicbox
HERE=$(cd "$(dirname "$0")" && pwd)

# Node 24 for everyone (node:sqlite needs 22.13+; Ubuntu's own nodejs package is older).
if [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y rclone jq rsync curl

id musicbox &>/dev/null || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin musicbox
install -d -o musicbox -g musicbox -m 750 "$ROOT" "$ROOT/app" "$ROOT/data" "$ROOT/library" "$ROOT/logs"

if [ ! -f "$ROOT/app/.env" ]; then
  cat > "$ROOT/app/.env" <<EOF
PORT=4300
HOST=127.0.0.1
LIBRARY_DIR=$ROOT/library
DB_PATH=$ROOT/data/musicbox.db
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
EOF
  chown musicbox:musicbox "$ROOT/app/.env"; chmod 600 "$ROOT/app/.env"
fi

cp "$HERE"/musicbox*.service "$HERE"/musicbox*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable musicbox.service
systemctl enable --now musicbox-update.timer musicbox-backup.timer

# Caddy site block, kept between markers so a re-run replaces it.
CF=/etc/caddy/Caddyfile
awk '/^# >>> musicbox/{skip=1} !skip{print} /^# <<< musicbox/{skip=0}' "$CF" > "$CF.new"
cat >> "$CF.new" <<EOF
# >>> musicbox (managed by narendras-musicbox deploy/linux/setup.sh)
$SITE {
	encode zstd gzip
	request_body {
		max_size 100MB
	}
	reverse_proxy 127.0.0.1:4300
}
# <<< musicbox
EOF
caddy validate --adapter caddyfile --config "$CF.new" >/dev/null
mv "$CF.new" "$CF"
systemctl reload caddy

# First install: deploy the newest green commit on main now instead of waiting for the timer.
[ -s "$ROOT/deployed.txt" ] || bash "$HERE/update.sh"
echo "Done. Live commit: $(cat "$ROOT/deployed.txt" 2>/dev/null || echo none) - log: $ROOT/logs/update.log"
