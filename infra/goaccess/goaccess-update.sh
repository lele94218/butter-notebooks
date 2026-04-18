#!/bin/bash
# Regenerates the goaccess HTML report from nginx access logs.
# Installed on VPS at /usr/local/bin/goaccess-update.sh, run every 5 min by cron.
set -e
OUT=/var/www/butter-notebooks/_stats
mkdir -p "$OUT"
# goaccess 1.3 doesn't predefine VCOMBINED, so the format is spelled out.
# Layout: $host $remote_addr - $remote_user [date time tz] "req" status bytes "ref" "ua"
goaccess /var/log/nginx/access.log \
  --log-format='%v %h %^[%d:%t %^] "%r" %s %b "%R" "%u"' \
  --date-format='%d/%b/%Y' \
  --time-format='%H:%M:%S' \
  --output="$OUT/index.html" \
  --no-progress \
  --anonymize-ip \
  2>/dev/null
chmod 644 "$OUT/index.html"
