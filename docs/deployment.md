# Deploying Lindero

One small Linux server (a "droplet"). Nginx terminates TLS and serves the built
frontend; the Fastify API runs as a systemd service behind it on loopback; the
SQLite file and the uploads directory live on the server's disk and are backed
up nightly, off the machine.

This is deliberately modest — see the "Database: SQLite, deliberately" section in
[architecture.md](architecture.md) for why, and for what it costs (one process,
one machine).

## Layout on the server

```
/opt/lindero/                 the git checkout
  backend/
    dist/                     built by `npm run build`
    drizzle/                  migration files (also copied into dist/ by the build)
    data/
      lindero.db              the database  (DATABASE_PATH)
      uploads/                proof-of-payment files  (UPLOADS_PATH)
    backups/                  local snapshots  (BACKUP_PATH)
    .env                      secrets and config — NOT in git
  frontend/
    dist/                     built by `npm run build` — Nginx serves this
```

Run the service as a dedicated unprivileged user:

```bash
sudo adduser --system --group --home /opt/lindero lindero
sudo git clone <repo> /opt/lindero
sudo chown -R lindero:lindero /opt/lindero
```

## First deploy

Node 22 or newer, installed system-wide. The systemd unit runs
`/usr/bin/node`, and it does not read a shell profile — a Node installed
through `nvm` lives under a user's home directory and will not be found. Use
NodeSource (or the distribution's package) so the binary is on that path:

```bash
node --version && command -v node      # expect v22+ at /usr/bin/node
```

```bash
cd /opt/lindero
sudo -u lindero npm ci                   # a plain `npm ci` — the build needs
                                         # typescript and vite, which are
                                         # devDependencies
sudo -u lindero npm run build            # builds both frontend and backend

# The two directories systemd will bind-mount as writable. Neither is in git,
# so a fresh clone has neither, and the unit fails to START without them — with
# a mount-namespace error that says nothing about Lindero. Make them first.
sudo -u lindero mkdir -p backend/data backend/backups

# backend/.env — from backend/.env.example, then edit:
#   NODE_ENV=production
#   HOST=127.0.0.1                              # loopback ONLY — see below
#   COOKIE_SECRET=<openssl rand -base64 48>     # the server refuses to boot without this
#   FRONTEND_ORIGIN=https://your-domain
#   TRUST_PROXY=127.0.0.1                       # matches the Nginx config
#   DATABASE_PATH=/opt/lindero/backend/data/lindero.db
#   UPLOADS_PATH=/opt/lindero/backend/data/uploads
#   BACKUP_PATH=/opt/lindero/backend/backups
#   TIME_ZONE=America/Tegucigalpa                # the OFFICE's calendar, not the
#                                                # server's — dates are decided in it
sudo -u lindero cp backend/.env.example backend/.env
sudo -u lindero editor backend/.env

# The API service. Migrations run on boot, so there is no separate migrate step.
sudo cp deploy/lindero-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lindero-api
journalctl -u lindero-api -f              # expect "Server listening at http://0.0.0.0:3000"

# The first owner account (interactive — asks for a name, email, password):
sudo -u lindero npm run db:bootstrap --workspace @lindero/backend

# Nginx: start from docs/nginx.conf.example, replace every <PLACEHOLDER>, read it
# once end to end, then reload. certbot for the TLS certificate.
```

## Shutting the front door

Two independent things keep the API off the public internet, and it wants both:
`HOST=127.0.0.1` above, so it only ever binds loopback, and a firewall, so a
future misconfiguration is not immediately reachable.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH            # do this BEFORE enabling, or you lock yourself out
sudo ufw allow 'Nginx Full'       # 80 and 443
sudo ufw enable
sudo ufw status verbose           # 3000 must NOT appear
```

Check it from somewhere else — not from the droplet, where loopback answers
regardless:

```bash
curl -sS --max-time 5 http://<DROPLET_IP>:3000/api/health   # expect: refused / timeout
curl -sS --max-time 5 https://<YOUR_DOMAIN>/api/health      # expect: a response
```

If the first one answers, the API is exposed: passwords and session cookies are
crossing the network unencrypted, and `TRUST_PROXY` is trusting a header on
requests that never passed through Nginx. Fix it before the first real login.

## Subsequent deploys

```bash
cd /opt/lindero
sudo -u lindero git pull
sudo -u lindero npm ci
sudo -u lindero npm run build
sudo systemctl restart lindero-api       # migrations run on restart
```

If a migration fails or `COOKIE_SECRET` is missing, the service exits non-zero
and `systemctl status lindero-api` shows why — it does not come up on a
half-built schema.

## Backups

`backend/scripts/backup.mjs` writes a consistent snapshot of the database
(`VACUUM INTO`) and a tarball of the uploads directory, under the same
timestamp, into `BACKUP_PATH`. It prunes snapshots older than `BACKUP_KEEP_DAYS`
(default 14).

```bash
sudo cp deploy/lindero-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lindero-backup.timer
sudo systemctl start lindero-backup       # run one now
ls -la /opt/lindero/backend/backups
```

**Off the machine.** A snapshot on the same disk as the database is not a
backup. Add an off-site copy step — the `ExecStartPost` line in
`lindero-backup.service` has an rclone example; a provider volume snapshot on a
schedule also works. Do this before go-live.

### Restoring — test this before go-live

```bash
sudo systemctl stop lindero-api

# The database: the snapshot IS a complete database file, so restoring is a copy.
sudo -u lindero cp /opt/lindero/backend/backups/lindero-<stamp>.db \
                   /opt/lindero/backend/data/lindero.db
sudo -u lindero rm -f /opt/lindero/backend/data/lindero.db-wal \
                      /opt/lindero/backend/data/lindero.db-shm

# The uploads:
sudo -u lindero rm -rf /opt/lindero/backend/data/uploads
sudo -u lindero tar -xzf /opt/lindero/backend/backups/uploads-<stamp>.tar.gz \
                   -C /opt/lindero/backend/data

sudo systemctl start lindero-api
```

Then sign in and open a receipt with an attachment: the row and the file are
restored from two different archives, and this is the check that both landed.
