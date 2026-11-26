# Later versions

What waits until Lindero has paying customers, and why. This is not a promise
or a schedule. It is the list to choose from when that day comes, so nothing
that was set aside on purpose gets lost.

Each item says what it is, why it waits, and what would bring it forward.
When one is built, delete it from here in the same pull request.

## 1. Before the first paying customer

These are what it takes to sell Lindero, and to make that safe.

The aim, set on 25 Nov 2026: anyone can create an account, use Lindero free for
a month and then pay, with nothing for the owner to set up by hand.

**One app, one database file per business.** Lindero is built for one business:
no table says which business a row belongs to, and that stays. One program
serves every business at one address. Each business has its own SQLite file and
uploads folder. A small accounts database records which business each email
belongs to, when its free month ends and whether it has paid. After sign-in, a
request opens only that business's file. At first, one email belongs to one
business. The business that uses Lindero today becomes the first one, with the
file it has now. There is no subdomain per business: making one by hand gets in
the way of advertising, and making one automatically would let a public signup
page change the server. This replaces "one copy per customer", decided on
5 Nov 2026.

What it takes, in this order:

1. Keep businesses apart. Done for the routes: each one works on `request.db`,
   which `db/pickDatabase.ts` chooses for every request (today always the one
   business's file). The choice still has to come from the signed-in
   account. The uploads folder, the live
   update stream and its version number (`lib/changes.ts`), the migrations at
   startup, the exchange rate timer and the nightly backup need the same. Close
   the files nobody is using, and give SQLite a smaller cache per file. A test
   proves that one business cannot read another's records.
2. Accounts: signup, email confirmation and «forgot password». Today only a
   supervisor can replace a password, so a supervisor who forgets theirs has
   nobody to ask. Sending mail needs an email service, because DigitalOcean
   blocks the mail ports on droplets.
3. The free month, counted by Lindero itself, with no card at signup. When it
   ends without payment, the account becomes view-only. Lindero never deletes
   its data.
4. Payment. The price and the way of paying are not decided yet. Before
   building on a payment company, have it accept the business.

**Two droplets.** Today's droplet keeps the weight software, whose address does
not change, with the Junta de agua and its test copy. A second 1 GB droplet gets
Lindero and its test site, so strangers signing up never share a machine with
the scales. Both with weekly backups, plus Spaces, come to about $19.40 a month
(prices read 25 Nov 2026). It is not needed until signup is about to open. This
replaces the earlier plan of one 2 GB droplet.

**Upload limits.** The disk is likely to run out before the memory. Every plan
needs a limit on uploads, and the free month a small one. Nothing is deleted
when a free month ends, so this limit is what keeps abandoned trials from
filling the disk.

**Safety for a public signup page.** A check against automated signups, a limit
on how many accounts one address can create, and pages with the terms and the
privacy policy.

**The security items left from the October 2026 review.**

- An upload is accepted when the browser says it is an image or a PDF
  (`lib/storedFiles.ts`). Also check the file's first bytes, so a file that
  claims to be a photo really is one.
- Write the steps to change `COOKIE_SECRET`, for when a staff member leaves on
  bad terms or the secret leaks. Changing it signs everyone out.

**Backups for every business, with a restore tried.** The real site's nightly
snapshot goes to Spaces (`deploy/lindero-backup.service`). It has to cover
every business's file and the accounts database. Before anyone depends on it,
restore one business once and check that the others were not touched.

## 2. When customers ask for it

**Businesses outside Honduras.** Lindero keeps money in lempiras, with a dollar
rate to show beside it, and `TIME_ZONE` is one setting for the whole server.
Honduran businesses need no change. Brings it forward: wanting to advertise in
another country.

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
one file per business, and separate files keep each business's data apart.
