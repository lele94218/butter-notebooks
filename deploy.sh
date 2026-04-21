#!/bin/bash
set -e

cd "$(dirname "$0")/frontend"
npm run build

rsync -az --delete -e "ssh -i ~/.ssh/id_ed25519" \
  dist/ root@vmi868767.your-tailnet.ts.net:/var/www/butter-notebooks/

# macOS ships openrsync (2.6.9-compat) which doesn't support --chmod.
# Fix ownership and permissions via SSH after transfer instead.
ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net "
  find /var/www/butter-notebooks -not -path '*/_stats*' -type d -exec chmod 755 {} + &&
  find /var/www/butter-notebooks -not -path '*/_stats*' -type f -exec chmod 644 {} + &&
  chown -R www-data:www-data /var/www/butter-notebooks
"

echo "Deploy done → https://your-site.example.com"
