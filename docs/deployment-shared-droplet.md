# Deploying Lindero next to Báscula Central

[deployment.md](deployment.md) describes a droplet where Lindero is the only
thing running. This one is not: `bascula-central` (the weight-station software,
`Elvis-techh/weight_software`) already lives there, and the scale stations in
the field depend on it every working day.

So this document is not a second deployment guide. It is the list of places
where the standard guide would **break the neighbour**, and what to do instead.
Read [deployment.md](deployment.md) for the parts that do not change — the
layout under `/opt/lindero`, the backup and restore procedure, what each `.env`
value means.

## Status — what is already done (2026-09-04)

The droplet has moved on since this document was written. Confirmed on the
machine, so the steps below can be skipped or adapted rather than re-run:

| Step | State |
|---|---|
| 0 — Inventory | Done. Node on `/usr/bin/node` is **v20.20.2**, so step 3 is still required. |
| 2 — Swap | **Done, 2 GB** (not the 1 GB below). Survives reboot via `/etc/fstab`. |
| 9 — Nginx + certbot | Both already installed (nginx 1.24.0, Ubuntu 24.04). |
| 9 — TLS | **Certificate already issued** for `lindero.basculacentral.com`, via `certbot certonly --webroot -w /var/www/certbot`, expiring 2026-12-04. `certbot renew --dry-run` passes for it and for `api.basculacentral.com`. Do **not** re-run `certbot --nginx`; point the site at the existing files under `/etc/letsencrypt/live/lindero.basculacentral.com/`. |
| 10 — Firewall | Done. `ufw` active with 22, 3000 and 80/443 allowed. Port 3000 stays open for the scale stations. |
| "If the droplet gets too small" | **Done.** Resized 512 MB → 1 GB and 10 GB → 25 GB on 2026-09-04. The disk half is not reversible. |

Remaining before Lindero runs: steps 1, 3, 4, 5, 6, 7, 8, 11 and 12.

Two notes that the resize changed. `basculacentral.com`, `api.` and `lindero.`
are all `A` records at `159.89.84.60`, all **DNS only** (unproxied) in
Cloudflare — leave them that way; certbot's HTTP-01 renewal depends on it, and
proxying would move the client's real address into a header
`TRUST_PROXY=127.0.0.1` does not read. And there is now a temporary nginx block
at `/etc/nginx/sites-available/lindero` serving only the ACME challenge; step 9
replaces it.

## What is already on the droplet

Established by reading `Elvis-techh/weight_software`; confirm each one against
the running machine in step 0 before trusting it.

| | Báscula Central | Lindero |
|---|---|---|
| Process | Express 4 + `sqlite3` | Fastify + `better-sqlite3` |
| Supervised by | PM2, **as root** | systemd, as user `lindero` |
| Lives in | `/root/weight_software/backend` | `/opt/lindero` |
| Listens on | `0.0.0.0:3000` — **public** | `127.0.0.1:3001` — loopback only |
| Reached by | Electron desktop clients, direct over HTTP, shared `API_KEY` | Browsers, over HTTPS, through Nginx |
| Backups | hourly, to DO Spaces `weight-station-storage` | nightly, `lindero-backup.timer` |

The important asymmetry: **the scale stations dial the droplet's IP on port
3000 directly.** There is no proxy in front of it and no hostname. Anything
that closes port 3000, changes the droplet's IP, or restarts the box takes the
weight stations down with it.

## The four collisions

### 1. Port 3000 is taken

Lindero defaults to 3000 too. Set `PORT=3001` in `backend/.env`, and change
`proxy_pass` in the Nginx site to match — `docs/nginx.conf.example` still says
`http://127.0.0.1:3000`, which would point Lindero's own frontend at the scale
API.

This one is loud rather than dangerous: whichever process starts second gets
`EADDRINUSE` and refuses to boot. Nothing is silently misrouted.

### 2. The firewall in deployment.md cuts off every scale station

[deployment.md](deployment.md) says to enable `ufw` allowing only SSH and
Nginx, and states that "3000 must NOT appear". That is correct for a droplet
running Lindero alone. Run it here and every weight station loses the server
the moment `ufw enable` returns.

Port 3000 must stay open:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80, 443 — Lindero
sudo ufw allow 3000/tcp          # bascula-central — the scale stations
sudo ufw enable
```

If the stations have fixed public addresses, `ufw allow from <IP> to any port
3000 proto tcp` is much better than opening it to the internet. They usually do
not, on consumer connections.

Lindero's own port must *not* be opened. `HOST=127.0.0.1` means it never binds
a public interface in the first place; the firewall is the second, independent
guard.

### 3. Building on the droplet can kill the neighbour

512 MB of RAM, no swap by default. `vite build` on a React 19 frontend
routinely peaks several hundred megabytes — well past what is free here. When
Linux runs out, the OOM killer chooses its victim by memory footprint, not by
who caused the problem: **the process it kills may be bascula-central**, in the
middle of a working day, while you are running a Lindero deploy.

Two changes, and this repo's build is designed to allow both:

- **Add swap** (step 2 below). Insurance for the runtime, not just the build.
- **Never build on the droplet.** `npm run build` on your laptop produces
  `frontend/dist` (~630 KB) and `backend/dist` (~1.2 MB). Both are copied up
  with `rsync`. The droplet runs `npm ci --omit=dev`, which installs no
  `typescript` and no `vite` at all.

This deliberately contradicts [deployment.md](deployment.md), which warns
against `--omit=dev` because the build needs those devDependencies. It is right
— on a droplet that does the building. This one does not.

Do **not** rsync `node_modules` from the laptop instead. `better-sqlite3` is a
compiled native module tied to a Node ABI, and the two machines are not on the
same Node major. It has to be installed on the droplet, by the same Node that
will run it.

### 4. Upgrading Node system-wide breaks bascula-central

Lindero needs Node 22 or newer. `bascula-central` depends on `sqlite3`, also a
native module, compiled against whatever Node is on the droplet now. Replacing
`/usr/bin/node` under it — which is what a NodeSource install does — leaves it
throwing `NODE_MODULE_VERSION` errors on its next restart, including the
unattended restart after a reboot.

Install Node 22 to a path of its own and leave `/usr/bin/node` exactly as
bascula-central found it (step 3). Nothing on `PATH` changes; the systemd unit
names the interpreter absolutely.

## The steps

### 0. Inventory, before changing anything

Everything above is inferred from a public repository. Confirm it:

```bash
free -h; swapon --show                 # expect ~460Mi total, no swap
df -h /                                # expect ~5.6G available
node --version; command -v node        # bascula's Node — note it down
pm2 list                               # expect bascula running
ss -tlnp                               # expect node on 0.0.0.0:3000
ufw status verbose                     # active already, or inactive?
systemctl is-active nginx; nginx -v    # installed already, or not?
ls /etc/nginx/sites-enabled/ 2>/dev/null
```

Two answers change the plan: if `ufw` is already active, do not re-run the
`default deny` lines in step 7 — only add the rules. If Nginx is already
serving something, step 6 adds a `server` block beside it rather than a first
one.

### 1. Back up the neighbour first

```bash
cd /root/weight_software/backend
node scripts/backup-database.js
```

Confirm it landed in Spaces. Everything after this touches a machine the scale
business runs on; this is the copy that makes the day recoverable.

### 2. Swap — 1 GB

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
free -h
```

Costs 1 GB of the 5.6 GB free. `swappiness=10` keeps the kernel from paging out
a healthy process just because swap exists — it is there for the spike, not for
everyday use.

### 3. Node 22, beside the existing one

Skip if step 0 already reported v22 or newer.

```bash
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz
sudo mkdir -p /opt/node22
sudo tar -xJf node-v22.21.1-linux-x64.tar.xz -C /opt/node22 --strip-components=1
/opt/node22/bin/node --version          # v22.21.1
command -v node                         # UNCHANGED — still bascula's
```

Check https://nodejs.org/dist/ for the current v22 LTS patch release rather
than copying the version above verbatim.

### 4. The checkout and its runtime dependencies

```bash
sudo adduser --system --group --home /opt/lindero lindero
sudo git clone https://github.com/Elvis-techh/land-management.git /opt/lindero
sudo chown -R lindero:lindero /opt/lindero

cd /opt/lindero
sudo -u lindero -H env "PATH=/opt/node22/bin:$PATH" /opt/node22/bin/npm ci --omit=dev
sudo -u lindero -H mkdir -p backend/data backend/backups
```

**`PATH` is not optional here, and naming `/opt/node22/bin/npm` is not enough.**
That file is a symlink to `npm-cli.js`, whose shebang is `#!/usr/bin/env node`
— so it does not run under the Node beside it, it asks `PATH` for "node" and
finds bascula-central's v20. npm then reports `EBADENGINE ... current: node
v20.20.2`, node-gyp fetches v20 headers, and because `better-sqlite3@13`
requires Node >=22 it publishes no prebuilt binary for that ABI, so the install
falls back to compiling from source. Putting `/opt/node22/bin` first fixes all
of it. **If you see any `EBADENGINE` warning, stop** — the binary that install
produces is for the wrong ABI and the service will fail to load it.

`-H` matters too: without it npm can inherit root's `HOME` and try to write its
cache to `/root/.npm`, failing with an error that reads like a network problem.

Install the toolchain first anyway, as insurance for the times a prebuilt
binary genuinely is unavailable; the swap from step 2 is what lets a compile
finish:

```bash
sudo apt install -y python3 build-essential
```

Then prove the native module matches the interpreter that will run it:

```bash
sudo -u lindero -H /opt/node22/bin/node \
  -e "require('/opt/lindero/node_modules/better-sqlite3'); console.log('ok')"
```

### 5. `backend/.env`

```bash
sudo -u lindero cp backend/.env.example backend/.env
sudo -u lindero openssl rand -base64 48      # paste into COOKIE_SECRET
sudo -u lindero editor backend/.env
```

Everything [deployment.md](deployment.md) lists, plus the two that are specific
to sharing the machine:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3001                                   # NOT 3000 — bascula has it
TRUST_PROXY=127.0.0.1
COOKIE_SECRET=<the openssl output>
FRONTEND_ORIGIN=https://<your-domain>
DATABASE_PATH=/opt/lindero/backend/data/lindero.db
UPLOADS_PATH=/opt/lindero/backend/data/uploads
BACKUP_PATH=/opt/lindero/backend/backups
BACKUP_KEEP_DAYS=3                          # NOT 14 — see "Disk" below
TIME_ZONE=America/Tegucigalpa
```

**Disk.** Every backup run tars the *whole* uploads directory afresh. Proof-of-
payment photos accumulate, and 14 of those tarballs on a disk with 4.6 GB free
— shared with bascula-central's database — is how both applications stop
writing at the same moment. Keep 3 days locally and push the rest off the
machine (step 9), which is what bascula-central already does with its 2.

### 6. Build on the laptop, copy up

From the repository on your own machine:

```bash
npm ci
npm run build
npm test                                     # optional, but it is fast

rsync -av --delete frontend/dist/ root@<DROPLET_IP>:/var/www/lindero/frontend/dist/
rsync -av --delete backend/dist/  root@<DROPLET_IP>:/opt/lindero/backend/dist/
```

Then on the droplet:

```bash
sudo mkdir -p /var/www/lindero/frontend
sudo chown -R lindero:lindero /opt/lindero/backend/dist
```

`backend/dist/drizzle` is part of what the build produces and what `rsync`
carries up — the migrations run from there on boot.

### 7. The service, with limits

```bash
sudo cp /opt/lindero/deploy/lindero-api.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/lindero-api.service.d
```

`/etc/systemd/system/lindero-api.service.d/droplet.conf` — a drop-in rather
than an edit, so a later `cp` of the unit does not undo it:

```ini
[Service]
# The unit ships /usr/bin/node, which on this droplet is bascula-central's.
ExecStart=
ExecStart=/opt/node22/bin/node dist/server.js

# bascula-central runs under PM2 with no cgroup limits, so it cannot be told to
# yield. Lindero can. Under memory pressure the kernel now kills something
# inside THIS cgroup instead of choosing the largest process on the box — which
# would often be the scale API.
MemoryHigh=200M
MemoryMax=256M
CPUWeight=50
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lindero-api
journalctl -u lindero-api -f          # expect: listening on 127.0.0.1:3001
systemctl show lindero-api -p MemoryCurrent    # watch this for a few days
```

If `MemoryCurrent` sits near `MemoryHigh`, raise both — a process being
throttled constantly is worse than one using another 50 MB.

### 8. Your existing data

This is the step that answers "so I do not lose data locally". After it, the
droplet holds the only copy that matters and every device reads the same
ledger.

On the laptop, with the dev server **stopped**:

```bash
cd backend
npm run db:backup            # VACUUM INTO — a clean file, no -wal to carry
scp backups/lindero-<stamp>.db root@<DROPLET_IP>:/tmp/
# and the uploads tarball too, if backups/uploads-<stamp>.tar.gz was written
```

On the droplet:

```bash
sudo systemctl stop lindero-api
sudo install -o lindero -g lindero -m 640 /tmp/lindero-<stamp>.db \
     /opt/lindero/backend/data/lindero.db
sudo rm -f /opt/lindero/backend/data/lindero.db-wal \
           /opt/lindero/backend/data/lindero.db-shm
sudo systemctl start lindero-api
```

Do **not** run `npm run db:bootstrap` afterwards. The accounts came up inside
that file, with their passwords; bootstrap is for a droplet starting empty.
Everyone will have to sign in again — the new `COOKIE_SECRET` invalidates the
old sessions — but with the credentials they already use.

From here, the laptop's `backend/data/lindero.db` is a scratch copy. Real work
happens on the server.

### 9. Nginx and TLS

**A domain is not optional.** In production the session cookie is issued with
`secure: true` (`backend/src/routes/auth.ts`), so the browser will not store or
return it over plain HTTP. Lindero on `http://<IP>` cannot log anybody in, and
Let's Encrypt does not issue certificates for bare IP addresses. Point an A
record at the droplet before this step.

```bash
sudo apt install -y nginx
sudo cp /opt/lindero/docs/nginx.conf.example /etc/nginx/sites-available/lindero
sudo editor /etc/nginx/sites-available/lindero
```

Replace every `<PLACEHOLDER>`, and change `proxy_pass` to
`http://127.0.0.1:3001`. Give the block an explicit `server_name`; do not mark
it `default_server` if Nginx is already serving something else.

```bash
sudo ln -s /etc/nginx/sites-available/lindero /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <your-domain>
```

The live-updates feed is server-sent events. It needs no extra Nginx
configuration: the endpoint sends `X-Accel-Buffering: no` itself, and its 25-
second heartbeat stays inside Nginx's 60-second `proxy_read_timeout`.

### 10. Firewall

As in collision 2 above. If `ufw` was already active in step 0, add only the
missing rules.

### 11. Backups, off the machine

```bash
sudo cp /opt/lindero/deploy/lindero-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lindero-backup.timer
sudo systemctl start lindero-backup
ls -la /opt/lindero/backend/backups
```

Then uncomment the `ExecStartPost` rclone line in the service and point it at
Spaces. Prefer a **separate access key and bucket** from bascula-central's: one
leaked key should not expose both businesses' records. If they must share a
bucket, at least give Lindero its own prefix.

### 12. Verify both applications

```bash
# From somewhere that is NOT the droplet:
curl -sS --max-time 5 http://<DROPLET_IP>:3000/           # bascula: answers
curl -sS --max-time 5 http://<DROPLET_IP>:3001/api/health # Lindero: refused
curl -sS --max-time 5 https://<your-domain>/api/health    # Lindero: answers
```

Then, in this order: open a scale station and weigh something; sign in to
Lindero and open a contract; run `free -h` and `pm2 list` while both are in
use. The third check is the one people skip — the failure mode of this droplet
is not a wrong answer, it is memory.

## Deploying again, later

```bash
# laptop
npm ci && npm run build
rsync -av --delete frontend/dist/ root@<IP>:/var/www/lindero/frontend/dist/
rsync -av --delete backend/dist/  root@<IP>:/opt/lindero/backend/dist/

# droplet
cd /opt/lindero
sudo -u lindero -H git pull
sudo -u lindero -H env "PATH=/opt/node22/bin:$PATH" /opt/node22/bin/npm ci --omit=dev
sudo systemctl restart lindero-api        # migrations run on restart
```

`git pull` is still needed: it brings `deploy/`, `docs/` and the `drizzle/`
migration sources, and keeps `package-lock.json` in step with `npm ci`.

## If the droplet gets too small

Everything above is mitigation for one number: 512 MB shared between two
applications. Resizing to 1 GB is a couple of dollars a month and removes the
memory risk outright rather than managing it — and on DigitalOcean a
CPU/RAM-only resize is reversible, unlike growing the disk. Do it before adding
a third thing to this machine.
