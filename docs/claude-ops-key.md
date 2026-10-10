# Claude's locked key to the droplet

Claude has its own SSH key to the droplet, and on the droplet that key is
locked to one program, `deploy/claude-ops.sh`, the same way the GitHub deploy
key is locked to `deploy/ssh-deploy.sh`. Whatever Claude sends, the droplet
runs that program and nothing else. The program accepts one word from a fixed
list and refuses everything else:

| Action | What it does | Changes anything? |
|---|---|---|
| `help` | Lists the actions | No |
| `status` | Both apps' health, memory, disk, Lindero's service, which build is live, bascula's pm2 pid and restarts | No |
| `nginx` | Lindero's nginx site file, its snippets (installed vs repository), `nginx -t` | No |
| `logs` | The last lines of Lindero's, the autodeploy's and the backup's logs, with secret-looking values masked | No |
| `install-headers` | Runbook step 9d (browser security headers), with its checks | nginx: Lindero's site file and one snippet |
| `undo-headers` | Takes the step 9d include lines out again | nginx: Lindero's site file |

What it cannot do: open a shell, run a command it was sent, forward ports,
copy files, read `.env`, `rclone.conf` or bascula's settings, restart either
application, or touch bascula-central's files.

How the two nginx actions keep bascula-central safe: they save a copy of the
site file first, refuse unless the edit lands in exactly the expected places,
reload only after `nginx -t` passes (a reload, never a restart), then compare
both applications' answers before and after. If anything differs, they put the
previous files back and reload again.

Every run is logged on the droplet, including refused ones:
`journalctl -t lindero-claude-ops -n 20`.

## Why a pinned copy

The key does not run the file in `/opt/lindero`, which every deploy updates. It
runs a copy at `/usr/local/sbin/lindero-claude-ops` that only changes when you
copy it in by hand. So a merged pull request cannot quietly give the key new
powers: that takes you, in the console, on purpose.

## Setting it up, once

**1. On the laptop (Claude does this).** A key made only for this, and a
shortcut that offers that key and no other:

```bash
ssh-keygen -t ed25519 -N "" -C claude-ops -f ~/.ssh/lindero-claude-ops
cat >> ~/.ssh/config <<'EOF'

Host lindero-ops
  HostName 159.89.84.60
  User root
  IdentityFile ~/.ssh/lindero-claude-ops
  IdentitiesOnly yes
  IdentityAgent none
  RequestTTY no
EOF
```

`IdentitiesOnly` and `IdentityAgent none` matter: without them SSH would also
offer the laptop's admin key, which is not locked, and the droplet would accept
that one instead. The private key never leaves the laptop. Claude prints the
public half (which is safe to share) as a ready-made line for step 2.

**2. In the droplet console (you do this),** after the change that added
`deploy/claude-ops.sh` has been deployed:

```bash
cd /opt/lindero && sudo -u lindero -H git pull --ff-only
install -m 755 -o root -g root /opt/lindero/deploy/claude-ops.sh /usr/local/sbin/lindero-claude-ops
install -d -m 700 /root/.ssh
echo 'restrict,command="/usr/local/sbin/lindero-claude-ops" ssh-ed25519 AAAA…REPLACE… claude-ops' >> /root/.ssh/authorized_keys
```

The last line is the one Claude gives you with the real key in it. `restrict`
turns off everything but the command; `command=` is the lock.

**3. Check the lock (Claude does this).**

```bash
ssh lindero-ops help     # the list of actions
ssh lindero-ops id       # must say "Refused": proves the key cannot run commands
ssh lindero-ops status
```

**4. Claude Code's permission.** Claude Code's own safety check blocks SSH to
production by default. Allow only this shortcut, e.g. the rule
`Bash(ssh lindero-ops:*)` in the laptop's Claude Code settings. The droplet,
not the rule, decides what is allowed.

## When `claude-ops.sh` changes

After the pull request is merged and deployed, copy it in again:

```bash
install -m 755 -o root -g root /opt/lindero/deploy/claude-ops.sh /usr/local/sbin/lindero-claude-ops
sha256sum /opt/lindero/deploy/claude-ops.sh /usr/local/sbin/lindero-claude-ops   # the two must match
```

## Taking it away

In the droplet console, at any time:

```bash
sed -i '/claude-ops/d' /root/.ssh/authorized_keys
```

The key stops working immediately. To remove the program too:
`rm /usr/local/sbin/lindero-claude-ops`.
