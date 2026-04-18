# VPS nginx config

Live paths on VPS `vmi868767`:
- `/etc/nginx/sites-enabled/your-site.example.com` ← `your-site.example.com.conf`
- `/etc/nginx/sites-enabled/your-other-site.example.com`  ← `your-other-site.example.com.conf` (410 tombstone)
- `/etc/nginx/conf.d/rate-limits.conf`     ← `rate-limits.conf`
- `/etc/nginx/conf.d/logging.conf`         ← `logging.conf`    (defines `vcombined` log format)

These files are manual snapshots — **not** auto-deployed.
To apply changes:

```bash
scp -i ~/.ssh/id_ed25519 infra/nginx/rate-limits.conf \
  root@vmi868767.your-tailnet.ts.net:/etc/nginx/conf.d/rate-limits.conf

scp -i ~/.ssh/id_ed25519 infra/nginx/logging.conf \
  root@vmi868767.your-tailnet.ts.net:/etc/nginx/conf.d/logging.conf

scp -i ~/.ssh/id_ed25519 infra/nginx/your-site.example.com.conf \
  root@vmi868767.your-tailnet.ts.net:/etc/nginx/sites-enabled/your-site.example.com

scp -i ~/.ssh/id_ed25519 infra/nginx/your-other-site.example.com.conf \
  root@vmi868767.your-tailnet.ts.net:/etc/nginx/sites-enabled/your-other-site.example.com

ssh -i ~/.ssh/id_ed25519 root@vmi868767.your-tailnet.ts.net \
  "nginx -t && nginx -s reload"
```

Notes:
- `client_max_body_size 20M` lets phone photos upload via `/v1/upload`
  without hitting 413 Payload Too Large.
- API proxies to the Mac mini over Tailscale (`YOUR.MAC.TAILSCALE.IP:8765`).
- Rate limits (see `rate-limits.conf`): `/v1/*` capped at 10 r/s per IP
  (burst 30, 20 concurrent); `/v1/upload` capped at 2 r/s per IP.
  Exceeding returns 429.
- `your-other-site.example.com` is a 410 tombstone for a decommissioned Mastodon instance —
  signals fediverse peers to stop retrying `/inbox` deliveries.
- `logging.conf` defines a `vcombined` format (adds `$host` as first field)
  so goaccess can group stats by virtual host. Each site's server block
  sets `access_log ... vcombined;` to opt in.
