# Share a comprobante into Lindero

Turning "the customer sent a deposit slip on WhatsApp" into a posted payment and
a sent receipt, in under a minute, from a phone, without typing figures.

The flow this builds, end to end:

```
WhatsApp  →  Share  →  Lindero  →  AI reads the image  →  you pick the customer
                          ↓              ↓                        ↓
                    image saved as   amount, date,          confirm the numbers
                    the comprobante  method, reference        against the photo
                                        prefilled                   ↓
                                                          save → "Enviar" → chat
```

## What this does NOT build

Stated first, because scope creep here costs money rather than time.

- **No automatic posting.** The AI never writes a payment. It fills a form; a
  person confirms it. A misread amount that posts silently produces a wrong
  balance and a receipt sent to a customer saying so, which is worse than a late
  receipt. See "Why a human stays in the loop" at the end.
- **No reading of WhatsApp chats.** Monitoring chats needs an unofficial library
  driving a logged-in session, and the account it would risk is the number the
  whole business runs on. Sharing is a deliberate gesture and carries no such
  risk.
- **No server-side sending.** "Enviar" still runs on your device, as it does
  today. Sending from the server needs the WhatsApp Cloud API — a separate
  number, business verification, approved templates. Out of scope here.
- **No iOS.** Web Share Target is Chromium-only. Android, Windows and Linux are
  covered; if iPhone support is ever needed the intake half is replaced by an
  iOS Shortcut posting to the same endpoint, and nothing else changes.

## Ground rules for building this without breaking anything

1. **Work on `feat/comprobante-intake`, never on `main`.** Each phase below is
   its own commit and is deployable on its own.
2. **Never build on the droplet.** 512 MB, no swap, and the OOM killer picks its
   victim by memory footprint — which can be `bascula-central`, mid-workday.
   Build on the laptop, copy `frontend/dist` up. See
   [deployment-shared-droplet.md](deployment-shared-droplet.md).
3. **Back up the database before any phase that adds a migration.** Only Phase 5
   does.
4. **The service worker is the one genuinely dangerous piece.** A bad one caches
   a broken build and keeps serving it after the fix is deployed. Phase 1 is
   written specifically to avoid that — read its notes before changing it.

---

# Phase 0 — HTTPS on a real domain

**Status: the infrastructure half is DONE as of 2026-09-04.** The DNS record
exists and the certificate is issued — the record below is how it was done, kept
for the next time. What remains of Phase 0 is the nginx site config,
`FRONTEND_ORIGIN`, and the verification at the end, and all three of those now
belong to the first Lindero deploy (see
[deployment-shared-droplet.md](deployment-shared-droplet.md)), because there was
no deployed app to put behind TLS when this was written.

**You do this one. No code changes.**

This is not optional polish. Three browser APIs this feature is built on —
service workers, PWA install, and the clipboard — do not exist on a plain
`http://` page. Not "work worse": `navigator.clipboard` and
`navigator.serviceWorker` are `undefined`, with no error to catch. That is
already why "Enviar" silently degrades when you open Lindero as
`http://192.168.1.37:5173` (see the note in
[frontend/src/features/receipts/whatsapp.ts](../frontend/src/features/receipts/whatsapp.ts)).

## 0.1 — Point a subdomain at the droplet, in Cloudflare

Use the domain you already have there for the weight software. A subdomain costs
nothing and keeps the two apps independent.

In the Cloudflare dashboard → your domain → **DNS** → **Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `lindero` (gives you `lindero.<TU_DOMINIO>`) |
| IPv4 address | the droplet's public IP |
| Proxy status | **DNS only** (grey cloud) — see below |
| TTL | Auto |

**Grey cloud, not orange, and this is deliberate.** The usual reason to proxy is
to hide the origin IP. That reason does not apply here: the scale stations dial
this droplet's IP directly on port 3000, so the address is already public and
has to stay that way. Proxying would hide nothing, and would cost you three
things — `certbot`'s HTTP-01 challenge needs extra care, the real client IP
arrives in `CF-Connecting-IP` instead of where `TRUST_PROXY=127.0.0.1` expects
it (so `request.ip` in the audit log becomes a Cloudflare edge address), and
Cloudflare will happily cache the service worker file unless told not to.

Orange cloud is a fine thing to revisit later, deliberately. Not on day one.

Verify before continuing — from your laptop, not the droplet:

```bash
dig +short lindero.<TU_DOMINIO>      # expect the droplet's IP
```

## 0.2 — Nginx and the certificate

Order matters here. The 443 server block in
[nginx.conf.example](nginx.conf.example) references certificate files that do
not exist yet, and Nginx refuses to start with a config pointing at a missing
certificate. So: port 80 first, get the certificate, then add 443.

```bash
# On the droplet.
sudo apt install nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
```

Create `/etc/nginx/sites-available/lindero` with **only** the port-80 block from
[nginx.conf.example](nginx.conf.example) for now — the one with the
`/.well-known/acme-challenge/` location — but drop its `return 301` redirect
until the certificate exists, or the challenge redirects to a site that is not
serving yet:

```bash
sudo ln -s /etc/nginx/sites-available/lindero /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` before every reload, always. It is the difference between a typo you
fix in ten seconds and a web server that will not start.

**This does not touch `bascula-central`.** The weight software is supervised by
PM2 and listens on `0.0.0.0:3000` directly, with no proxy in front of it —
nothing about installing or reloading Nginx reaches it. The one thing that
*would* cut it off is the `ufw` rule set in [deployment.md](deployment.md); do
not run that here. Follow the firewall section of
[deployment-shared-droplet.md](deployment-shared-droplet.md), which keeps 3000
open.

Then the certificate:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d lindero.<TU_DOMINIO>
```

Now add the 443 block from [nginx.conf.example](nginx.conf.example), restore the
redirect in the port-80 block, and remember the two edits that document already
flags for this droplet:

- `proxy_pass http://127.0.0.1:3001;` — **3001, not 3000.** 3000 is the scale
  API. Pointing Lindero's frontend at it is the one mistake here that fails
  quietly instead of loudly.
- Leave `Strict-Transport-Security` commented out until HTTPS is confirmed
  working. It is sticky in the browser and not quickly undone.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 0.3 — Point the backend at the new origin

In `/opt/lindero/backend/.env`:

```
FRONTEND_ORIGIN=https://lindero.<TU_DOMINIO>
```

```bash
sudo systemctl restart lindero-api
```

## 0.4 — Verify, including that you did not break the neighbour

```bash
# From the laptop.
curl -sS -o /dev/null -w '%{http_code}\n' https://lindero.<TU_DOMINIO>/api/health
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://<DROPLET_IP>:3000/
#   ^ bascula-central: must still ANSWER (any HTTP status is fine — 200, 401,
#     404, all prove the port is open and the process is alive). A refusal or a
#     timeout means the scale stations are down.  Better still: have someone
#     weigh something.
```

Then open `https://lindero.<TU_DOMINIO>` on the Android phone, log in, open a
receipt and press **Enviar**. It should now copy the image and open the
customer's chat — the good path, not the "open in a tab" fallback. If that
works, every browser API the rest of this plan needs is available.

**Phase 0 is done when Enviar works over HTTPS on the phone and the scale
stations are still up.** Nothing after this is worth starting until then.

---

# Phase 1 — Make Lindero installable

**Goal:** the app can be installed to the Android home screen. No behaviour
changes for anyone who does not install it.

Web Share Target only works for an *installed* PWA, so this has to come first.

**Changes:**

- `frontend/public/manifest.webmanifest` — name, `short_name`, `start_url: "/"`,
  `display: "standalone"`, theme colours, and icons at 192×192 and 512×512
  (Chrome requires both sizes; without them the install prompt never appears).
- `frontend/public/icons/` — the two PNGs.
- `frontend/index.html` — `<link rel="manifest" ...>`.
- `frontend/public/sw.js` — the service worker.
- `frontend/src/main.tsx` — register it, in production only.

**The service worker must not cache anything.** This is the single most
important line in this document. A caching service worker that ships with a
broken build keeps serving that broken build to an installed app *after* you
deploy the fix, and the usual reaction — deploy again — does not help. Phase 1's
worker exists for exactly two reasons: to satisfy Chrome's installability check
(which wants a `fetch` handler), and in Phase 2 to catch the share POST. So its
`fetch` handler passes everything straight through to the network and caches
nothing, and it calls `skipWaiting()` + `clients.claim()` so a new version takes
over immediately instead of waiting for every tab to close.

Write the kill switch in the same commit, as a comment at the top of `sw.js`:
replacing the file's body with `self.registration.unregister()` and deploying
that removes the worker from every device on next load. Knowing the escape hatch
exists is what makes this safe to ship.

**Verify:** on the Android phone, Chrome menu shows "Install app" / "Add to home
screen". Install it, open it, log in, load the Recibos screen. In DevTools →
Application → Service Workers (or `chrome://inspect`), confirm the worker is
activated and the Cache Storage list is **empty**.

**Rollback:** revert the commit and redeploy; the registration disappears on the
next load. If a worker is already stuck on a device, ship the kill switch.

---

# Phase 2 — Share into the new-receipt dialog

**Goal:** sharing an image from WhatsApp opens Lindero's new-receipt dialog with
the image already attached. Still no AI. This phase alone is already worth
having.

**Changes:**

- `manifest.webmanifest` gains a `share_target`:

  ```json
  "share_target": {
    "action": "/compartir",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "files": [{ "name": "comprobante", "accept": ["image/*", "application/pdf"] }]
    }
  }
  ```

  `text` is there on purpose. Customers sometimes forward the bank's
  notification as text rather than a screenshot, and Phase 3 reads either.

- `sw.js` gains a `fetch` handler for `POST /compartir`: read `event.request
  .formData()`, put the file and text into IndexedDB under a random id, and
  answer with `Response.redirect('/recibos/nuevo?compartido=<id>', 303)`.

  **Why the detour through IndexedDB.** The share POST is a navigation the
  browser makes on behalf of another app; a `SameSite=Lax` session cookie is not
  reliably attached to it, so posting it at the API directly would arrive
  unauthenticated. Letting the service worker take it means the request never
  leaves the device, and the redirect that follows is an ordinary same-origin
  GET that carries the session normally.

- `ReceiptsPage.tsx` / router: on `?compartido=<id>`, pull the blob out of
  IndexedDB, delete it, open `NewReceiptDialog` with that file seeded into its
  `proofs` state, and strip the query parameter so a refresh does not re-open it.

**This needs no backend change and no schema change.**
[NewReceiptDialog.tsx](../frontend/src/features/receipts/NewReceiptDialog.tsx)
already holds proofs client-side as `PendingProof[]` and uploads them after the
receipt is created — because `attachments.receipt_id` is `NOT NULL`, so a file
cannot exist before the receipt does. A shared image is just another
`PendingProof`; it takes the path the dropzone already takes.

**Verify:** on the phone, long-press a deposit slip in WhatsApp → Share →
Lindero. The dialog opens with the image showing as a proof thumbnail. Fill it
in by hand, save, and confirm the attachment is on the receipt afterwards.

**Rollback:** revert. The share target disappears from the OS share sheet once
the manifest no longer advertises it.

---

# Phase 3 — The extraction endpoint

**Goal:** `POST /api/comprobantes/extract` takes an image or a block of text and
returns structured figures with per-field confidence. Not wired to the UI yet —
this phase is finished when it reads your seven test images correctly.

**Changes:**

- `npm install @anthropic-ai/sdk --workspace @lindero/backend`
- `backend/.env` + `.env.example`: `ANTHROPIC_API_KEY=`, and a
  `COMPROBANTE_AI_ENABLED=false` flag so the endpoint can be dark-launched.
- `backend/src/config/env.ts`: both, following the existing `loadConfig` shape.
- `backend/src/lib/comprobante.ts`: the prompt, the schema, the cross-checks.
- `backend/src/routes/comprobantes.ts`: the route, behind `app.requireUser`,
  rate-limited, accepting the same content types and 12 MB ceiling as
  [lib/attachments.ts](../backend/src/lib/attachments.ts).

**The call.** `claude-opus-5`, vision, with structured output via
`client.messages.parse()` and `zodOutputFormat` — the project already uses Zod
for request validation, so the schema is written in a familiar style and the
response is typed rather than a JSON string to be parsed by hand. Adaptive
thinking on, `effort: "medium"` to start, tuned from the fixture results.

Fields to return: `amount`, `currency`, `date`, `time`, `bank`,
`accountNumber`, `reference`, `documentNumber`, `depositorName`,
`depositorIdentification`, `method`, plus `confidence` per field and a
`warnings` array.

**Make it check its own work.** These come straight from your real slips and are
the difference between a useful extractor and a plausible one:

- **The `SON:` line.** Occidente prints the amount in words —
  `SON:***SIETE MIL CON 00/100***`. Parse it and compare against the numeral. It
  catches the comma/period confusion (`30.000.00` vs `30,000.00`) that a photo
  of a carbon copy invites.
- **The footer code.** `180820261001 40 61360915` decomposes as `DDMMYYYY` +
  `HHMMSS` + the document number. On the Primera Calle slip the printed
  `F. Actual` reads `10/08/2026` while the footer and `F. Proceso` both say the
  18th — the footer wins, and a mismatch is a warning worth surfacing.
- **Account normalisation.** MoneyGram prints `212160221818`; Occidente prints
  `21-216-022181-8`. Strip non-digits before comparing. A slip naming an account
  that is not yours is a warning, loudly.
- **Remittances: take the destination amount.** The MoneyGram slip carries
  `539.75 USD`, `555.15 USD` and `14,500.98 HNL`. The only one that belongs on
  the contract is the last. Return `originalAmount` + `originalCurrency` +
  `exchangeRate` as well — `payments` already has columns for all three — and
  warn that the bank may credit slightly less after its own fees.

**Build the fixture set first.** Save the seven images you already have into
`backend/test/fixtures/comprobantes/`, with a JSON file next to each holding the
correct answer, typed by hand. Then a script that runs all seven and diffs.
This is the whole quality bar for the feature, and it costs an afternoon:

| Fixture | Expect |
|---|---|
| `occidente-progreso.jpg` | L 15,000.13, 04/09/2026 14:24:33, doc 56060289, Vilma Patricia Avelar Andino, ID 0107200001545 |
| `occidente-tela.jpg` | L 30,000.00, 04/09/2026 12:42:59, doc 59340232, Maira Janeth Aguilar Martinez |
| `occidente-primera-calle.jpg` | L 7,000.00, **18**/08/2026 10:01:40, doc 61360915, Sonia Argentina Paredess Barahona |
| `moneygram.jpg` | **14,500.98 HNL** (not 555.15 USD), ref 58071669, rate 26.8661 |
| `bac-notificacion.png` | L 7,000.00, 29/08/2026 08:52, ref 412401817, Sara Elisma Espinoza |
| `bac-agente.jpg` | L 7,000.00, 29/08/2026 13:58:45, ref 004473 — **no depositor name exists** |
| `envio-confirmado.png` | 14,000.00 HNL — **and nothing else; no date, no reference** |

The last two matter most. They are the cases where the correct output is "I
found an amount and nothing that identifies who paid", and an extractor that
invents a name for them is worse than useless. Test that it doesn't.

**Cost.** Roughly 2,500 input tokens (a phone photo is ~1,500) and ~300 output
per receipt — about **US$0.02 each**, so on the order of $2/month at a hundred
receipts. An estimate, not a quote; measure `response.usage` once it runs.

**Verify:** `curl` each fixture at the endpoint and diff against its expected
JSON. Nothing in the UI has changed yet, so there is nothing to roll back beyond
reverting the commit.

---

# Phase 4 — Wire it into the dialog

**Goal:** the shared image is extracted and the form is prefilled. Two taps to a
saved receipt.

**Changes:**

- On Phase 2's redirect, call the Phase 3 endpoint with the shared file, showing
  a spinner in the dialog while it runs.
- Prefill `amountCents`, `paidOn`, `method`, `reference`, and the currency
  fields. Leave `type` alone — the AI should not guess whether something is a
  down payment or an installment; the contract already implies it.
- **Show what was read next to what it was read from.** The extracted amount
  sits beside the image, both on screen, because the confirming glance is the
  whole point. A field the model was unsure about renders in a warning colour
  rather than looking like a fact.
- **Suggest customers; never select one.** Rank by `depositorIdentification`
  against `customers.identification` (already uniquely indexed at
  [schema.ts:263](../backend/src/db/schema.ts#L263)) first, then by name
  similarity, then leave the picker open. You tap; the app does not decide.
- If extraction fails or the flag is off, the dialog opens exactly as Phase 2
  left it — image attached, fields blank. **A failed extraction must never block
  saving a receipt.**

**One thing to confirm with real data before trusting it.** On the Occidente
slips, `IDENTIFICACION` changes with the depositor while `Cuentahabiente` stays
`RIVERA LOPEZ MANUEL`, so the field is almost certainly the *depositor's*
cédula. Check one — does `1607195100120` match Sonia Argentina Paredess Barahona
in your customer records? If yes, the strongest matching signal in this whole
feature is confirmed. If not, the matcher falls back to names and this bullet
gets deleted.

**Expect third-party payers to be normal.** Ever Galeas, in Detroit, is paying
for somebody's lot. The name on the slip often will not be the customer's. That
is an argument for a small "known payers" table later — remember once that this
person pays for that contract — not for cleverer name matching now.

**Verify:** run all seven fixtures through the real UI on the phone and time it.
Target is under a minute, most of it spent reading.

---

# Phase 5 — Guardrails

**Goal:** the things that stop this from being fast *and wrong*.

- **Duplicate reference warning.** Before saving, check whether a non-reversed
  payment already carries this `reference`. Warn — do not block; a customer can
  legitimately pay twice. This is the one that matters: your BAC notification
  and your BAC agent slip are **both L 7,000.00, both to account ...3081, both
  on 29/08/2026**, hours apart. Amount and date do not identify a payment.
  Only the reference does.
- **Record the provenance.** A small `comprobante_extractions` table — the
  attachment it came from, the raw model output, the model id, what the human
  changed before saving. This needs a migration, so back up first. It is what
  lets you answer "did the AI get this wrong, or did I mistype it" in six
  months, and it is the data that tells you when auto-posting is safe.
- **Audit note** on payments created through this path, via the existing
  `recordAudit` in [lib/audit.ts](../backend/src/lib/audit.ts).
- **Rate limit** the extraction endpoint per user, following the pattern
  `LOGIN_ATTEMPTS_PER_MINUTE` already establishes.

---

# Why a human stays in the loop

Of the seven confirmations here, three can be matched to a customer
automatically with real confidence. One — the MoneyGram slip — names a sender
who is not the customer. Two identify nobody at all: the BAC agent slip has no
depositor field, and the "Envío confirmado" screenshot has no name, no date and
no reference.

For those, the model cannot match a customer, because the information is not in
the image. An automatic pipeline would have to guess, and a wrong guess sends
one customer's name, identidad and balance to a different person — a privacy
incident, not a typo. That is the same reasoning that already put the clipboard
path ahead of the share sheet in
[whatsapp.ts](../frontend/src/features/receipts/whatsapp.ts).

One more thing worth remembering when this feels slow: a photo of a deposit slip
is the customer's *claim* that they paid. It is not proof the money reached the
account, and photos can be edited. This feature removes the typing. It does not
replace checking the statement.
