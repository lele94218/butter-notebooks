# goaccess stats dashboard

Served at `https://your-site.example.com/_stats/` (basic auth, user `butter`).
Regenerated every 5 minutes from nginx access logs.

## Files on VPS

- `/usr/local/bin/goaccess-update.sh` ← `goaccess-update.sh`
- `/etc/cron.d/goaccess` — `*/5 * * * * root /usr/local/bin/goaccess-update.sh >/dev/null 2>&1`
- `/etc/nginx/auth/butter-stats.htpasswd` — basic auth credentials (generated with `htpasswd`, not in git)
- `/var/www/butter-notebooks/_stats/index.html` — generated report

## Deploy / update script

```bash
scp -i ~/.ssh/id_ed25519 infra/goaccess/goaccess-update.sh \
  root@vmi868767.your-tailnet.ts.net:/usr/local/bin/goaccess-update.sh

ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net \
  "chmod +x /usr/local/bin/goaccess-update.sh && /usr/local/bin/goaccess-update.sh"
```

## Rotate password

```bash
ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net \
  "htpasswd /etc/nginx/auth/butter-stats.htpasswd butter"
```
