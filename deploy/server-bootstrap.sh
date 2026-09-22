#!/usr/bin/env bash
# One-shot bootstrap on an Ubuntu/Debian server that already runs nginx (run as root):
#   certbot, service user, git clone, first deploy, Let's Encrypt certificate, https site,
#   systemd service + auto-deploy timer.
# Before running: put .env.local (with PUBLIC_BASE_URL=https://<host>) into $TARGET, and the ROMs
# into $TARGET/roms (both are git-ignored, so the clone does not bring them).
# Usage:  bash server-bootstrap.sh
set -euo pipefail

TARGET="${TARGET:-/opt/jev-fc-buddy}"
REPO="${REPO:-https://github.com/work4life2/jev-fc-buddy.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-jevbuddy}"
export DEBIAN_FRONTEND=noninteractive

echo "[bootstrap] packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl git nginx certbot
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  echo "[bootstrap] node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$SERVICE_USER" -s /bin/bash "$SERVICE_USER"

mkdir -p "$TARGET"
chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET"
if [ ! -d "$TARGET/.git" ]; then
  # init + fetch instead of clone so an .env.local / roms dropped in beforehand survive
  echo "[bootstrap] fetch $REPO -> $TARGET"
  runuser -u "$SERVICE_USER" -- git -C "$TARGET" init -q -b "$BRANCH"
  runuser -u "$SERVICE_USER" -- git -C "$TARGET" remote add origin "$REPO"
  runuser -u "$SERVICE_USER" -- git -C "$TARGET" fetch -q origin "$BRANCH"
  runuser -u "$SERVICE_USER" -- git -C "$TARGET" reset -q --hard "origin/$BRANCH"
fi
runuser -u "$SERVICE_USER" -- mkdir -p "$TARGET/data" "$TARGET/roms"

HOST="$(sed -nE 's#^PUBLIC_BASE_URL=https?://([^/]+).*#\1#p' "$TARGET/.env.local" | tail -1)"
[ -n "$HOST" ] || { echo "PUBLIC_BASE_URL missing in $TARGET/.env.local" >&2; exit 1; }

echo "[bootstrap] first deploy (http-only site, for the ACME challenge)"
mkdir -p /var/www/certbot
TARGET="$TARGET" BRANCH="$BRANCH" SERVICE_USER="$SERVICE_USER" bash "$TARGET/deploy/deploy.sh" --force

if [ ! -f "/etc/letsencrypt/live/$HOST/fullchain.pem" ]; then
  echo "[bootstrap] certificate for $HOST"
  certbot certonly --webroot -w /var/www/certbot -d "$HOST" --non-interactive --agree-tos \
    --register-unsafely-without-email --deploy-hook "systemctl reload nginx"
  TARGET="$TARGET" BRANCH="$BRANCH" SERVICE_USER="$SERVICE_USER" bash "$TARGET/deploy/deploy.sh" --force
fi

systemctl enable -q jev-fc-buddy jev-fc-buddy-autodeploy.timer certbot.timer
systemctl start jev-fc-buddy-autodeploy.timer certbot.timer
echo "[bootstrap] done: https://$HOST/"
