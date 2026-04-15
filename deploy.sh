#!/bin/bash
set -e

cd "$(dirname "$0")/frontend"
npm run build

rsync -az --delete -e "ssh -i ~/.ssh/id_ed25519" \
  dist/ root@vmi868767.your-tailnet.ts.net:/var/www/butter-notebooks/

ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net \
  "chmod -R 755 /var/www/butter-notebooks"

echo "Deploy done → https://your-site.example.com"
