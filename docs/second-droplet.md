# The second droplet

`apps-02` is a second DigitalOcean droplet, for Lindero, its test site and later
the POS. The first one, `apps-01` (it was called `ubuntu-server` until now, which
older pages and screenshots still show), keeps the weight software, whose address
does not change, and the Junta de agua. So strangers who sign up for Lindero
never share a machine with the scales.

Before pasting anything into a droplet's console, check the name in its prompt.

**It does not serve Lindero yet.** The live site and the test site are still on
the first droplet ([deployment-shared-droplet.md](deployment-shared-droplet.md)),
and "Deploy" and "Deploy test" still go there.

Its IP address is not written here, because this repository is public.

## The order

| Step | What | State |
|---|---|---|
| 1 | Check the first droplet: region, backup bucket, size of the data | Done 27 Nov 2026 |
| 2 | Create the droplet and set up the machine (below) | |
| 3 | Make the scripts work on it, and give Claude a read-only key to it | The scripts are ready |
| 4 | Rehearse: install Lindero there under the new domain and restore it from the Spaces backup. **Its nightly backup stays off**, so practice data never mixes with real backups | Needs the new domain. Installing the live site there has no script yet |
| 5 | Switch over at a quiet hour: stop the old Lindero, its automatic deploys and its backup timer; make one last backup; check that the database and the photos reached Spaces; restore them on droplet 2; check the records; turn on its deploys and backups; then redirect the old address | |
| 6 | A week or two later: set up the test site on droplet 2 under the new domain, and remove the old one (`setup-test-site.sh --undo` on droplet 1) | |

Going back is easy only **until someone saves something on the new Lindero**.
After that, the new data has to be copied back too.

## Mistakes to avoid

- **Never create droplet 2 from a snapshot or backup of droplet 1.** It would
  copy the weight software too, and its backup timer could overwrite the real
  backups with old data.
- **Never delete `/opt/node22` from droplet 1.** The Junta's test copy uses it,
  although Lindero installed it.
- **Keep `lindero.basculacentral.com` pointing at droplet 1**, redirecting to the
  new address, and keep its certificate renewing: browsers that have visited it
  insist on HTTPS.
- **Tell Lindero's users first** to finish any unsaved form. Afterwards they sign
  in again, remove the old app from the phone and install the new one. Until
  they do, sharing a receipt from WhatsApp to the old app loses the file.
- **Add the new domain in Google Cloud Console**, to both the sign-in client and
  the API key, or the Google Drive button stops working.

## What droplet 2 is

Basic, 1 vCPU, 1 GB, 25 GB, in NYC1, Ubuntu 24.04, with weekly backups and
monitoring, and the laptop's own SSH key (not one of Claude's). Spaces is the
same subscription as droplet 1. Lindero's backups keep going to the
`lindero-backups` bucket, with a key limited to that bucket, so someone who got
into droplet 2 would hold nothing of the weight software's.

## Setting up the machine

`deploy/setup-new-droplet.sh` gives an empty droplet what droplet 1 has under
its apps: updates, 2 GB of swap, the journal capped at 200 MB, a firewall for
SSH and the web only, Nginx with certificate renewal, and Node 22 in
`/opt/node22`. It installs no app. It refuses to run on droplet 1, and running
it twice is safe. It ends with a report, which includes the machine's name.

In a terminal on the laptop, in the repository's folder. First the droplet's
address:

```bash
IP=PASTE_IP_HERE
```

Then the setup, which takes a few minutes:

```bash
scp deploy/setup-new-droplet.sh root@$IP:/root/ && ssh root@$IP bash /root/setup-new-droplet.sh apps-02
```

If it says a restart is needed, run `ssh root@$IP reboot` and wait a minute.
Then give Claude its read-only key
([claude-ops-key.md](claude-ops-key.md#droplet-2s-key)), which also lets Claude
check what the setup left behind.

Do not paste the script into DigitalOcean's "Startup script" box: it needs the
name, it waits for the droplet to finish starting (which a startup script is
part of), and nobody would see its result.

## How the scripts tell the droplets apart

The weight software's folder, `/root/weight_software`, is only on droplet 1.

| Script | Where the weight software is | Anywhere else |
|---|---|---|
| `setup-new-droplet.sh` | Refuses to run | Sets up the machine |
| `setup-claude-access.sh` | Refuses to run | Adds Claude's key |
| `setup-test-site.sh` | Also proves the weight software was left alone | Skips those checks |
| `claude-ops.sh` | Reads, and can add or remove the security headers | Only reads |

No script has Lindero's address written in it. `claude-ops.sh` reads each
site's address from that site's Nginx file, and `setup-test-site.sh` takes the
test site's address when you first run it.
