#!/bin/bash
# Regenerates the goaccess HTML report from nginx access logs.
# Installed on VPS at /usr/local/bin/goaccess-update.sh, run every 5 min by cron.
set -e
OUT=/var/www/butter-notebooks/_stats
mkdir -p "$OUT"
zcat -f /var/log/nginx/access.log* 2>/dev/null | \
  goaccess - \
    --log-format=COMBINED \
    --output="$OUT/index.html" \
    --no-progress \
    --anonymize-ip \
    2>/dev/null
chmod 644 "$OUT/index.html"
