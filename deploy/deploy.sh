#!/usr/bin/env bash
# Pull-based deploy: fetch origin/<branch>; if it moved (or --force), reset the checkout to it,
# install, build, refresh the systemd units + nginx site and restart the service.
# Run as root (it drops to the service user for git/npm). Same shape as 3dcardagent/deploy/deploy.sh.
#   deploy/deploy.sh            # deploy only if origin moved
#   deploy/deploy.sh --force    # always rebuild + restart
set -euo pipefail

TARGET="${TARGET:-/opt/jev-fc-buddy}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-jevbuddy}"
SERVICE="${SERVICE:-jev-fc-buddy}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

as_user() { runuser -u "$SERVICE_USER" -- "$@"; }

cd "$TARGET"
as_user git fetch -q origin "$BRANCH"
LOCAL="$(as_user git rev-parse HEAD)"
REMOTE="$(as_user git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = 0 ]; then
  exit 0
fi

echo "[deploy] $LOCAL -> $REMOTE"
as_user git reset -q --hard "origin/$BRANCH"
as_user npm ci --ignore-scripts --no-audit --no-fund
as_user npm run build

# systemd units
install -m 644 deploy/jev-fc-buddy.service /etc/systemd/system/jev-fc-buddy.service
sed -i "s/User=%i/User=$SERVICE_USER/; s#/opt/jev-fc-buddy#$TARGET#g" /etc/systemd/system/jev-fc-buddy.service
install -m 644 deploy/jev-fc-buddy-autodeploy.service deploy/jev-fc-buddy-autodeploy.timer /etc/systemd/system/
sed -i "s#/opt/jev-fc-buddy#$TARGET#g" /etc/systemd/system/jev-fc-buddy-autodeploy.service

# nginx: hostname comes from PUBLIC_BASE_URL in .env.local; TLS block only once the cert exists.
HOST="$(sed -nE 's#^PUBLIC_BASE_URL=https?://([^/]+).*#\1#p' .env.local 2>/dev/null | tail -1)"
if [ -n "$HOST" ] && [ -d /etc/nginx/sites-enabled ]; then
  SITE=/etc/nginx/sites-available/jev-fc-buddy
  sed "s/__HOST__/$HOST/g" deploy/nginx.conf > "$SITE"
  ADMIN="$(sed -nE 's#^ADMIN_PATH=/?([^/[:space:]]+)/?.*#/\1#p' .env.local 2>/dev/null | tail -1)"
  install -m 644 deploy/nginx-http.conf /etc/nginx/conf.d/jev-fc-buddy.conf
  if [ -f "/etc/letsencrypt/live/$HOST/fullchain.pem" ]; then
    sed "s/__HOST__/$HOST/g; s#__ADMIN__#${ADMIN:-/admin}#g" deploy/nginx-tls.conf >> "$SITE"
  else
    echo "[deploy] no certificate for $HOST yet: https block not installed (run deploy/server-bootstrap.sh or certbot)" >&2
  fi
  ln -sf "$SITE" /etc/nginx/sites-enabled/jev-fc-buddy
  nginx -t -q && systemctl reload nginx || echo "[deploy] nginx config invalid, not reloaded" >&2
fi

systemctl daemon-reload
systemctl restart "$SERVICE"
echo "[deploy] done: $(as_user git log -1 --format='%h %s')"
