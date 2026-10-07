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
| 10 — Firewall | Done, **with one rule too many.** `ufw` active with 22, 3000 and 80/443 allowed. No scale station uses 3000; delete that rule (collision 2). |
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
| Listens on | `0.0.0.0:3000` — **public**, though nothing needs it to be | `127.0.0.1:3001` — loopback only |
| Reached by | Electron desktop clients, over HTTPS at `api.basculacentral.com`, through Nginx; one `API_KEY` shared by every install | Browsers, over HTTPS, through Nginx |
| Backups | hourly, to DO Spaces `weight-station-storage` | nightly, `lindero-backup.timer` |

The important thing to know: **the scale stations reach bascula-central through
the same Nginx that will serve Lindero.** Every release of the desktop app,
from the first (`v.1.0.1`, 2026-07-27) on, has `https://api.basculacentral.com`
built in as its server (today's source for it is `frontend/environment.js` in
that repository); Nginx terminates TLS there and passes the requests to port
3000. Anything that stops Nginx, or restarts it on a broken config, takes the
weight stations down along with Lindero: reload rather than restart, and
`nginx -t` first, every time. If the droplet's IP ever changes, the `api.`
record has to follow it.

An earlier version of this section said the stations dial the droplet's IP on
port 3000 directly. No release of the app ever has, and the advice built on
that (keep 3000 open to the internet) is reversed in collision 2.

## The four collisions

### 1. Port 3000 is taken

Lindero defaults to 3000 too. Set `PORT=3001` in `backend/.env`, and change
`proxy_pass` in the Nginx site to match — `docs/nginx.conf.example` still says
`http://127.0.0.1:3000`, which would point Lindero's own frontend at the scale
API.

This one is loud rather than dangerous: whichever process starts second gets
`EADDRINUSE` and refuses to boot. Nothing is silently misrouted.

### 2. The firewall: close 3000, do not open it

[deployment.md](deployment.md) says to enable `ufw` allowing only SSH and
Nginx, and states that "3000 must NOT appear". That is right on this droplet
too. The stations arrive on 443, through Nginx (above), so a firewall without
3000 does not touch them.

And leaving 3000 open is not harmless. The only credential the scale API
checks, its `API_KEY`, is the same on every station and ships inside every
installer — that repository and its release downloads are public — so it
cannot be treated as a secret: anyone can act as a station. Through Nginx that
at least leaves an access log, and can be limited by address. Port 3000 skips
Nginx entirely: no TLS, no log, no `allow`/`deny`.

Close it, then stop bascula-central listening on the public interface at all:

```bash
# 1. Confirm the stations come in through Nginx: the station's address should
#    appear about every 15 s (the app polls /api/health; Lindero never does).
#    If it does not, stop here and find out why before closing anything.
sudo tail -f /var/log/nginx/access.log | grep --line-buffered '/api/health'

# 2. Close the door. This removes both the IPv4 and the IPv6 rule that
#    `ufw allow 3000/tcp` made. "Could not delete non-existent rule" means it
#    was added another way: `ufw status numbered`, then `ufw delete <n>` for
#    each 3000 line, highest number first.
sudo ufw delete allow 3000/tcp
sudo ufw status verbose          # 3000 must NOT appear

# 3. Before the second guard, check that the api. site proxies to the
#    loopback (127.0.0.1:3000 or localhost:3000), not to the public IP.
grep -rn proxy_pass /etc/nginx/sites-enabled/
```

Then add `HOST=127.0.0.1` to `/root/weight_software/backend/.env` and, at a
quiet moment, `pm2 restart bascula-backend` (or whatever `pm2 list` calls it).
`server.js` already reads `HOST`; nothing in the app changes. `ss -tlnp` should
show it on `127.0.0.1:3000` afterwards, not `0.0.0.0:3000`.

If the station's public address is fixed, Nginx can also admit only that
address to `api.basculacentral.com`'s `/api/` (`allow <IP>; deny all;` in that
location). The per-address limit belongs there now, where the stations
actually arrive. Most consumer connections do not have a fixed address, and a
changed one locks the station out.

Lindero's own port must *not* be opened either. `HOST=127.0.0.1` means it
never binds a public interface in the first place; the firewall is the second,
independent guard.

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
ss -tlnp                               # expect node on 0.0.0.0:3000 (collision 2)
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

### 7b. The first account — and why `npm run db:bootstrap` will not work here

[deployment.md](deployment.md) says to create the first owner with
`npm run db:bootstrap`. On this droplet that fails with `sh: 1: tsx: not
found`, and the reason is step 4: `--omit=dev` deliberately installs no
TypeScript toolchain, while every `db:*` script in `backend/package.json` runs
the TypeScript **source** through `tsx`. Both halves are right; they just
cannot both be true at once.

The compiled equivalents are already on the droplet — `tsc` emits all of `src`,
and `dist/db/` came up with the rsync in step 6. Run those instead, naming the
interpreter absolutely for the same reason the systemd units do:

```bash
cd /opt/lindero/backend
sudo -u lindero -H /opt/node22/bin/node --env-file-if-exists=.env dist/db/bootstrap.js
```

`--env-file-if-exists` is a Node flag (22.9+), not a tsx one, so `.env` is read
exactly as it would have been. The same substitution works for the other
scripts — `dist/db/migrate.js` and so on — though migrations already run on
boot, so that one is rarely needed.

**`db:seed` is the exception, and it should stay one.** It refuses to run when
`NODE_ENV=production`, because it inserts fictional customers with a password
published in the repository. To get something on screen here, create a handful
of records through the interface; keep the seeded demo data on the laptop,
where `npm run db:reset` still has tsx to run it.

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

The rules in [deployment.md](deployment.md) as they stand, SSH and Nginx only,
for the reasons in collision 2. If `ufw` was already active in step 0, add only
the missing rules, and delete the 3000 one.

### 11. Backups, off the machine

**This unit needs the same interpreter drop-in as step 7, for the same reason
— and forgetting it here is much quieter.** `lindero-api.service` fails to
start and you find out in seconds; this one runs at 02:15, so `better-sqlite3`
built for a different Node ABI surfaces as backups that have silently not
happened for a month.

Create the Space and its credentials first, in the DigitalOcean panel: a
**private** Space (`lindero-backups`, same region as the droplet), and a
**separate Spaces access key** from bascula-central's. One leaked key must not
expose both businesses' records. If they must share a bucket, at least give
Lindero its own prefix.

```bash
sudo apt install -y rclone

sudo -u lindero -H tee /opt/lindero/backend/rclone.conf >/dev/null <<'EOF'
[spaces]
type = s3
provider = DigitalOcean
endpoint = nyc3.digitaloceanspaces.com
acl = private
EOF

sudo -u lindero -H rclone --config /opt/lindero/backend/rclone.conf \
  config update spaces access_key_id <KEY> secret_access_key <SECRET>

sudo chmod 600 /opt/lindero/backend/rclone.conf   # it holds the secret key
```

```bash
sudo cp /opt/lindero/deploy/lindero-backup.{service,timer} /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/lindero-backup.service.d
```

`/etc/systemd/system/lindero-backup.service.d/droplet.conf`:

```ini
[Service]
# As in step 7: the unit ships /usr/bin/node, which here is bascula-central's.
ExecStart=
ExecStart=/opt/node22/bin/node scripts/backup.mjs

# One CPU is shared with the scale API; the nightly job queues behind it.
Nice=10

# The unit ships these lines commented out. Setting them here keeps the shipped
# file generic and puts the destination with the rest of this droplet's
# specifics. Two pieces, not one copy of the folder — see "What goes to the
# bucket" below for why.
ExecStartPost=/usr/bin/rclone --config /opt/lindero/backend/rclone.conf copy /opt/lindero/backend/backups spaces:lindero-backups/db --include "lindero-*.db" --size-only -v
ExecStartPost=/usr/bin/rclone --config /opt/lindero/backend/rclone.conf copy /opt/lindero/backend/data/uploads spaces:lindero-backups/uploads --size-only -v
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lindero-backup.timer
sudo systemctl start lindero-backup
journalctl -u lindero-backup -n 30 --no-pager
ls -la /opt/lindero/backend/backups
```

**Then prove the copy left the machine.** This is the step people skip, and the
only one that decides whether you have backups:

```bash
sudo -u lindero -H rclone --config /opt/lindero/backend/rclone.conf ls spaces:lindero-backups
```

A `db/lindero-<stamp>.db` listed there is a backup. An empty result means a
nightly job writing files onto the same disk as the database it is meant to
protect, which survives nothing that actually happens to disks.

Listing proves a file exists, not that it is the right one. Compare checksums —
this reads both sides and changes nothing:

```bash
RC="sudo -u lindero -H rclone --config /opt/lindero/backend/rclone.conf"
$RC check /opt/lindero/backend/data/uploads spaces:lindero-backups/uploads --one-way
$RC check /opt/lindero/backend/backups spaces:lindero-backups/db --include "lindero-*.db" --one-way
```

Both should end in `0 differences found`.

`readonly: true` in `scripts/backup.mjs` is what lets this run under
`ProtectSystem=strict` with only `backups/` writable — `VACUUM INTO` reads the
live database and writes a defragmented copy elsewhere, with no downtime.

#### What goes to the bucket, and keeping it small

```
spaces:lindero-backups/
  db/lindero-<stamp>.db     one per night, ~0.5 MB
  uploads/<random name>     ONE copy of every photo and scanned document
```

The first design was a single `rclone copy` of the whole `backups/` folder, and
it grew without limit. Each night's tarball is the entire uploads folder (57 MB
by the end of September), `copy` never deletes, and a new tarball has a new
name — so the bucket held one full copy of every photo for every night since
go-live: 1.07 GiB after 26 days, and growing by (size of the uploads folder) ×
(nights). Uploaded files are written once and never changed, so the bucket now
keeps one copy of each and `copy` sends only the ones it does not have. The
nightly tarball is still made in `backups/`, as a quick local undo, but it is
not uploaded.

`copy`, never `sync`. `copy` cannot delete from the bucket, so an empty or
missing uploads folder cannot wipe the off-site copy. The price is that a file
removed in the app stays in `uploads/`. That is deliberate: a removed signed
contract has no other copy anywhere, and the database snapshot from before the
removal still says which random name it was.

**Lifecycle rules** keep the rest bounded, but the DigitalOcean control panel
does not offer them (its Space settings have versioning, access logs, file
listing, CDN and CORS only). They are set through the S3 API — `s3cmd
setlifecycle`, or `aws s3api put-bucket-lifecycle-configuration` — with a key
that may change bucket settings, which Lindero's own key deliberately cannot (it
gets `AccessDenied`). They are optional now: the mirror already stops the
growth, leaving about 13 MB a month of new photos plus one small database copy
a night. Expiry is permanent unless versioning has been turned on, which it is
not by default — so the prefixes matter:

| Prefix | Expire after | Why |
|---|---|---|
| `db/` | 90 days | Small, and the only history of the database off the machine. |
| `lindero-` | 90 days | Database copies from the first design, at the top level. |
| `uploads-` | 30 days | Tarballs from the first design; superseded by `uploads/`. |
| `uploads/` | **never** | The only off-site copy of the photos. |

`uploads-` (with the hyphen) does not match `uploads/`, and an empty prefix
matches everything — do not leave one. bascula-central's Space is a different
bucket that also holds live attachments (`corapsa-*`, `gastos`); a rule there
must be limited to its `backups/` folder, never the whole Space.

#### Restoring from the bucket

```bash
sudo systemctl stop lindero-api
RC="sudo -u lindero -H rclone --config /opt/lindero/backend/rclone.conf"

# The database: pick a snapshot from `$RC ls spaces:lindero-backups/db`.
$RC copyto spaces:lindero-backups/db/lindero-<stamp>.db /opt/lindero/backend/data/lindero.db
sudo -u lindero rm -f /opt/lindero/backend/data/lindero.db-wal \
                      /opt/lindero/backend/data/lindero.db-shm

# The uploads: everything the bucket has.
$RC copy spaces:lindero-backups/uploads /opt/lindero/backend/data/uploads

sudo systemctl start lindero-api
```

A snapshot only ever points at files that were already in `uploads/` when it
was taken, and nothing is removed from that prefix, so the mirror always holds
at least what any snapshot needs. Extra files are harmless.

### 12. Verify both applications

```bash
# From somewhere that is NOT the droplet:
curl -sS --max-time 5 https://api.basculacentral.com/api/health # bascula: answers
curl -sS --max-time 5 http://<DROPLET_IP>:3000/api/health       # bascula: refused / timeout
curl -sS --max-time 5 http://<DROPLET_IP>:3001/api/health       # Lindero: refused / timeout
curl -sS --max-time 5 https://<your-domain>/api/health          # Lindero: answers
```

If Nginx admits only the station's address to bascula's `/api/`, the first
check answers 403 from anywhere else, which proves Nginx is up and nothing
more; the weighing below is then the check that counts.

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

### Without a laptop

The `deploy-build` branch carries `frontend/dist` and `backend/dist` built from
`main` (its `README.md` names the commit). With it current, the whole deploy
is two commands on the droplet — workable from a phone's SSH app:

```bash
cd /opt/lindero && sudo -u lindero -H git pull --ff-only
sudo bash deploy/update-from-build.sh
```

The script fetches the build, runs `npm ci --omit=dev` under Node 22, copies
both `dist` folders into place, refreshes the systemd unit if the repo's copy
changed, restarts, and waits for `/api/health`. `deploy-build` has to be
rebuilt after every change to `main` that touches code; a build from an older
commit deploys that older code.

## If the droplet gets too small

Everything above is mitigation for one number: 512 MB shared between two
applications. Resizing to 1 GB is a couple of dollars a month and removes the
memory risk outright rather than managing it — and on DigitalOcean a
CPU/RAM-only resize is reversible, unlike growing the disk. Do it before adding
a third thing to this machine.
