#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VPS="root@vmi868767.your-tailnet.ts.net"
SSH_KEY="$HOME/.ssh/id_ed25519"
PLIST_LABEL="ai.openclaw.butter-notebooks"

deploy_frontend() {
  echo "==> Building frontend..."
  cd "$SCRIPT_DIR/frontend"
  npm run build

  echo "==> Uploading to VPS..."
  rsync -az --delete -e "ssh -i $SSH_KEY" \
    dist/ "$VPS:/var/www/butter-notebooks/"

  ssh -i "$SSH_KEY" "$VPS" "
    find /var/www/butter-notebooks -not -path '*/_stats*' -type d -exec chmod 755 {} + &&
    find /var/www/butter-notebooks -not -path '*/_stats*' -type f -exec chmod 644 {} + &&
    chown -R www-data:www-data /var/www/butter-notebooks
  "
  echo "==> Frontend deployed → https://your-site.example.com"
}

deploy_backend() {
  echo "==> Restarting backend..."
  launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"
  sleep 2
  if launchctl list "$PLIST_LABEL" &>/dev/null; then
    echo "==> Backend restarted ($(launchctl list "$PLIST_LABEL" | awk '{print $1}' | head -1))"
  else
    echo "==> ERROR: backend failed to start. Check /tmp/butter-notebooks.log"
    exit 1
  fi
}

case "${1:-}" in
  --backend)
    deploy_backend
    ;;
  --all)
    deploy_frontend
    deploy_backend
    ;;
  ""|--frontend)
    deploy_frontend
    ;;
  *)
    echo "Usage: $0 [--frontend|--backend|--all]"
    exit 1
    ;;
esac
