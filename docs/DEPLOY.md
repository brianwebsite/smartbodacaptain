# Deploying the Smart Boda server

The server is one Node 22 process with a SQLite file. It needs no other software.

## What you need
- A small VPS (1 GB RAM is enough to start) with a fixed public IP. LivePay will need that IP whitelisted later.
- A domain name pointing at it (for example `api.yourdomain.com`). The phone apps need HTTPS on real devices.
- Docker installed on the VPS.

## Steps
1. Get the code: `git clone https://github.com/brianwebsite/smartbodacaptain && cd smartbodacaptain`
2. Build: `docker build -f backend/Dockerfile -t smartboda .`
3. Create a data folder: `mkdir -p /srv/smartboda-data && chown 1000:1000 /srv/smartboda-data`
4. Run (replace the values):

```
docker run -d --name smartboda --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v /srv/smartboda-data:/data \
  -e ADMIN_PHONE=0772XXXXXX -e ADMIN_PASSWORD='a-long-password-here' \
  -e GOOGLE_MAPS_API_KEY='your-key' -e TRUST_PROXY=1 \
  smartboda
```

5. HTTPS with Caddy (installs certificates by itself). In `/etc/caddy/Caddyfile`:

```
api.yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
```

6. Open `https://api.yourdomain.com/admin` and sign in with the admin phone and password. Approve captains there.

## Point the apps at the server
In GitHub: Settings > Secrets and variables > Actions > Variables > New variable `API_BASE_URL` = `https://api.yourdomain.com`. Re-run the "Android apps" workflow. Install the new APKs from the `android-latest` release.

## Backups
The whole database is one file: `/srv/smartboda-data/smartboda.db`. Copy it daily (`sqlite3 smartboda.db ".backup backup.db"`) to somewhere else.

## Without a Google key
The server still works but shows fares from straight-line distance and labels them "approximate". Add `GOOGLE_MAPS_API_KEY` (Routes API enabled) for real road distances.
