# Claude's locked keys to the droplets

Claude has its own SSH key to each droplet, and on the droplet that key is
locked to one program, `deploy/claude-ops.sh`, the same way the GitHub deploy
key is locked to `deploy/ssh-deploy.sh`. Whatever Claude sends, the droplet
runs that program and nothing else. The program accepts one word from a fixed
list and refuses everything else.

| Droplet | Claude connects with | What the key can do |
|---|---|---|
| 1, with the weight software | `ssh lindero-ops <action>` | Read, and add or remove the security headers |
| 2, [the second droplet](second-droplet.md) | `ssh lindero-ops-2 <action>` | Only read |

The difference is not a setting. The two actions that change something exist
only where the weight software's folder is, so on droplet 2 the program refuses
them like any other unknown word.

| Action | What it does | Changes anything? |
|---|---|---|
| `help` | Lists the actions | No |
| `status` | The apps' health, memory, disk, Lindero's service, which build is live, the journal's size and cap, the test site, and what else runs on the machine (Nginx site names, listening ports, the largest programs by short name). On droplet 1 also bascula's pm2 pid and restarts, and its place in line when memory runs out. On droplet 2 also what its setup left: swap, firewall, web server, certificate renewal, Node, whether SSH takes passwords and whether a restart is needed | No |
| `nginx` | Lindero's and its test site's nginx site files, their snippets (installed vs repository), `nginx -t` | No |
| `logs` | The last lines of Lindero's, the test site's, the autodeploy's and the backup's logs, with secret-looking values masked | No |
| `install-headers` | Droplet 1 only. Runbook step 9d (browser security headers), with its checks | nginx: Lindero's site file and one snippet |
| `undo-headers` | Droplet 1 only. Takes the step 9d include lines out again | nginx: Lindero's site file |

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

## Setting up droplet 1's key, once

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
cd /opt/lindero && sudo -u lindero -H git fetch --quiet origin main && sudo -u lindero -H git merge --ff-only origin/main
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

## Droplet 2's key

It has a key of its own, so taking one droplet's key away leaves the other
working. It can be set up on an empty droplet, before Lindero is there.

**1. On the laptop (Claude does this).** The key:

```bash
ssh-keygen -t ed25519 -N "" -C claude-ops-2 -f ~/.ssh/lindero-claude-ops-2
```

and, in `~/.ssh/config`, a second shortcut like droplet 1's above, named
`lindero-ops-2`, with droplet 2's IP address and
`IdentityFile ~/.ssh/lindero-claude-ops-2`.

**2. In a terminal on the laptop (you do this),** in the repository's folder,
after `IP=` and droplet 2's address:

```bash
scp deploy/claude-ops.sh deploy/setup-claude-access.sh ~/.ssh/lindero-claude-ops-2.pub root@$IP:/root/ && ssh root@$IP bash /root/setup-claude-access.sh /root/lindero-claude-ops-2.pub
```

`deploy/setup-claude-access.sh` copies the program into place and adds the key,
locked. It leaves every other key as it was, and refuses a key that can already
log in without the lock, so giving it your own key by mistake cannot lock you
out. Only the `.pub` file, which is safe to share, leaves the laptop.

**3. Check the lock (Claude does this).**

```bash
ssh lindero-ops-2 help     # help status nginx logs
ssh lindero-ops-2 id       # must say "Refused"
ssh lindero-ops-2 status
```

**4. Claude Code's permission:** the rule `Bash(ssh lindero-ops-2:*)`.

**When `claude-ops.sh` changes,** run step 2 again.

## When `claude-ops.sh` changes (droplet 1)

After the pull request is merged and deployed, copy it in again:

```bash
install -m 755 -o root -g root /opt/lindero/deploy/claude-ops.sh /usr/local/sbin/lindero-claude-ops
sha256sum /opt/lindero/deploy/claude-ops.sh /usr/local/sbin/lindero-claude-ops   # the two must match
```

## Taking it away

In that droplet's console, at any time:

```bash
sed -i '/claude-ops/d' /root/.ssh/authorized_keys
```

The key stops working immediately. To remove the program too:
`rm /usr/local/sbin/lindero-claude-ops`.
