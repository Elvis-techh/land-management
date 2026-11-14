# Later versions

What waits until Lindero has paying customers, and why. This is not a promise
or a schedule. It is the list to choose from when that day comes, so nothing
that was set aside on purpose gets lost.

Each item says what it is, why it waits, and what would bring it forward.
When one is built, delete it from here in the same pull request.

## 1. Before the first paying customer

These are not features. They are what makes it safe to sell Lindero.

**One copy of Lindero per customer.** Lindero is built for one business: no
table says which business a row belongs to. Each customer gets their own copy,
with its own subdomain, SQLite file, `.env`, backups and memory limit. The test
site (`deploy/setup-test-site.sh`) is already a second copy on the same
droplet, so the pattern exists. See section 1 of
`docs/postgres-readiness.md`.

**A bigger droplet.** Resize to the 2 GB Basic droplet (about $12 a month)
before the first customer goes live. Choose "CPU and RAM only" so it can be
undone. About seven customer copies of 100 MB fit then. Before resizing, check
that the weight software starts on its own after a reboot
(`systemctl is-enabled pm2-root`).

**The security items left from the October 2026 review.**

- The browser security policy (CSP) only reports problems today; it does not
  block anything. Switch it to enforce (`deploy/nginx-headers.conf`) after
  checking the reports are clean.
- An upload is accepted when the browser says it is an image or a PDF
  (`lib/storedFiles.ts`). Also check the file's first bytes, so a file that
  claims to be a photo really is one.
- Write the steps to change `COOKIE_SECRET`, for when a staff member leaves on
  bad terms or the secret leaks. Changing it signs everyone out.

**Backups for every copy, with one restore tried.** The real site's nightly
snapshot goes to Spaces (`deploy/lindero-backup.service`). Each customer copy
needs the same, and a restore of each one done once, before anyone depends on
it. Watch the Spaces bill as copies are added.

## 2. When customers ask for it

**The full story of a mora change in Historial.** Today a mora change records
what was done: the cuota, the date, the amount, the receipt and the reason.
A later version would also say what the rule alone would have charged and how
it got there: the rule in force (for example 10 %, maximum L. 500, 5 days of
grace), and each charge with its base («L. 200 on 6 Oct, 10 % of L. 2,000»).
It does not need to be stored: the rule history (`mora_rules`) already lets
Lindero work it out again for any date, as the contract's Mora tab does.
Why it waits: the payment form already shows this reasoning before anyone
saves, and Historial already names the receipt. Brings it forward: a customer
disputes a mora months later, after the rule has changed.

**Mora from a past date, in bulk.** A tool that works out what the mora rule
would have charged since a chosen date, shows it in a table to review, and
saves it as «Cargar mora» entries. Dropped on 29 Oct 2026 because nobody owed
mora from before 25 Oct. Brings it forward: a new customer moving from
spreadsheets with many late contracts.

**Reading comprobantes with AI.** Phases 3, 4 and 5b of
`docs/receipt-intake.md`: read the amount and reference from the photo.
Deferred while there are fewer than about 100 receipts a month, because typing
the amount is quick. A person always confirms the figures either way. Brings
it forward: a customer who receives many transfers a day.

**Accounting exports.** Payments, receipts and mora by month, as a spreadsheet
for the customer's accountant. Phase 3 of `docs/product-brief.md`. Likely one
of the first things a paying customer asks for.

**The rest of Phase 3** in `docs/product-brief.md`: a cash-flow forecast (what
falls due in the coming months, per project), a pipeline for prospects,
profitability per project, and working offline in the field.

## 3. Only when something forces it

**PostgreSQL.** One to two weeks of careful work, with real risk, and no gain
at today's size. `docs/postgres-readiness.md` lists the triggers (more than
one server, saves waiting on each other, one shared database for every
customer, contractual point-in-time recovery, tens of gigabytes) and every
place that would change.

**Every customer in one database.** Only if customers need reports across
each other or one shared server. Every table would need a column saying which
business owns the row, and every query a filter on it. A much bigger job than
one copy per customer, and the copies keep each customer's data physically
apart.
