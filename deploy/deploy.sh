#!/usr/bin/env bash
# Usage: deploy/deploy.sh user@host your.domain.com
# Copies WeMake to ~/wemake on the host, builds it, installs a systemd service
# bound to 127.0.0.1:8787 and an nginx site for the domain. Re-run to update.
set -euo pipefail
TARGET=${1:?user@host}; DOMAIN=${2:?domain}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .git ./ "$TARGET:wemake/"
ssh -t "$TARGET" DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail
cd ~/wemake
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node 20+ required (found $(node -v 2>/dev/null || echo none))"; exit 1; }
npm ci --no-audit --no-fund
npm run build
DIR=$(pwd); ME=$(whoami)
sed -e "s#__USER__#$ME#g" -e "s#__DIR__#$DIR#g" deploy/wemake.service | sudo tee /etc/systemd/system/wemake.service >/dev/null
sed -e "s#__DOMAIN__#$DOMAIN#g" deploy/nginx-wemake.conf | sudo tee /etc/nginx/sites-available/wemake >/dev/null
sudo ln -sf /etc/nginx/sites-available/wemake /etc/nginx/sites-enabled/wemake
sudo systemctl daemon-reload
sudo systemctl enable --now wemake
sudo systemctl restart wemake
sudo nginx -t && sudo systemctl reload nginx
sleep 2
curl -fsS -H "Host: $DOMAIN" http://127.0.0.1/api/time >/dev/null && echo "OK: WeMake is live behind nginx for $DOMAIN"
REMOTE
