# Deploying from GitHub Actions

`.github/workflows/deploy.yml` builds `main` on GitHub's machines, publishes
the result to the `deploy-build` branch, then connects to the droplet and runs
`deploy/update-from-build.sh` there. Once it is set up, a deploy is one button
(**Actions → Deploy → Run workflow**), or one request to Claude, from a phone.

Setup is once, in three parts: the droplet, GitHub, and a first run. Every
droplet step can be done in DigitalOcean's browser console (**Droplet → Access
→ Launch Droplet Console**), which logs you in as root.

## What the key can and cannot do

The workflow logs in with a key made only for it. On the droplet that key is
locked to a single command, `deploy/ssh-deploy.sh`: pull `main`, then deploy
the build. It cannot open a shell, run anything else, or forward ports, and
whatever the workflow sends is ignored apart from one word (below). Someone who
stole it could deploy what is already on GitHub, and nothing more.

To revoke it at any time:

```bash
sed -i '/github-deploy/d' /root/.ssh/authorized_keys
```

## 1. On the droplet

**Bring the scripts up to date:**

```bash
cd /opt/lindero && sudo -u lindero -H git pull --ff-only
```

**Read the Google Drive settings off the live site.** They are baked into the
JavaScript every browser already downloads, so they are public, and the live
copy is the one that is known to work:

```bash
grep -ohE "VITE_GOOGLE_[A-Z_]+:[\`\"'][^\`\"']+" /var/www/lindero/frontend/dist/assets/*.js | sort -u
```

Up to three lines, such as ``VITE_GOOGLE_API_KEY:`AIza…` ``. The value is what
follows the backtick. If nothing prints, the live site has no Drive button
today; see "Without Google Drive" below.

**Make the deploy key and lock it to the deploy command:**

```bash
ssh-keygen -t ed25519 -N "" -C github-deploy -f /root/gh-deploy
install -d -m 700 /root/.ssh
echo "restrict,command=\"bash /opt/lindero/deploy/ssh-deploy.sh\" $(cat /root/gh-deploy.pub)" >> /root/.ssh/authorized_keys
```

**Print the two values GitHub needs.** Each is one long line:

```bash
base64 -w0 /root/gh-deploy; echo                    # → DROPLET_SSH_KEY
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub   # → DROPLET_HOST_KEY
```

Leave the console open until part 2 is saved, then delete the key files. The
only copy of the private key should be the GitHub secret:

```bash
rm /root/gh-deploy /root/gh-deploy.pub
```

Root must be allowed to log in with a key, which is DigitalOcean's default.
`sshd -T | grep permitrootlogin` should say `yes`, `prohibit-password`,
`without-password` or `forced-commands-only`. If it says `no`, stop here.

## 2. On GitHub

In the repository: **Settings → Secrets and variables → Actions**. On a phone,
the browser's "Desktop site" mode shows the Settings tab when the app does not.

**Secrets** tab → **New repository secret**, three times:

| Name | Value |
|---|---|
| `DROPLET_HOST` | The droplet's IP address, from the DigitalOcean dashboard |
| `DROPLET_SSH_KEY` | The `base64` line from part 1 |
| `DROPLET_HOST_KEY` | The `ssh-ed25519 AAAA…` line from part 1 |

**Variables** tab → **New repository variable**, one per line the `grep`
printed:

| Name | Value |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | ends in `.apps.googleusercontent.com` |
| `VITE_GOOGLE_API_KEY` | starts with `AIza` |
| `VITE_GOOGLE_APP_ID` | a number |

Variables rather than secrets because they are public anyway, and readable
values make a wrong one easy to spot.

## 3. Run it

**Actions → Deploy → Run workflow**, or ask Claude to run it. It takes a few
minutes and fails loudly at the first step that goes wrong:

- **"VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY are not set"**: part 2's
  variables are missing.
- **"Permission denied (publickey)"**: the `authorized_keys` line, or the
  `DROPLET_SSH_KEY` secret, is wrong.
- **"Host key verification failed"**: `DROPLET_HOST_KEY` or `DROPLET_HOST`
  is wrong.
- **"The live site has Google Drive settings and this build does not"**: the
  droplet refused a build that would have hidden the Drive button. Check the
  variables.
- **"Not answering on port …"**: the server did not come back. The last 30
  log lines are in the output.

## Without Google Drive

If the live site has no Drive settings, or you mean to turn Drive off, tick
**without_drive** when running the workflow. It then builds without the
variables and tells the droplet (with the one word the key accepts,
`allow-drop-drive`) that dropping the button is intended.
