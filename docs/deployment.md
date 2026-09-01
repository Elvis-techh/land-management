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

```bash
cd /opt/lindero
sudo -u lindero npm ci
sudo -u lindero npm run build            # builds both frontend and backend

# backend/.env — from backend/.env.example, then edit:
#   NODE_ENV=production
#   COOKIE_SECRET=<openssl rand -base64 48>     # the server refuses to boot without this
#   FRONTEND_ORIGIN=https://your-domain
#   TRUST_PROXY=127.0.0.1                       # matches the Nginx config
#   DATABASE_PATH=/opt/lindero/backend/data/lindero.db
#   UPLOADS_PATH=/opt/lindero/backend/data/uploads
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
