# Working on Lindero

The owner is new to programming and often works from a phone, through a cloud
session. They can paste commands into the droplet console but cannot copy text out
of it; they send screenshots. Never ask for secrets in the chat.

## Deploying

Read docs/deployment-shared-droplet.md before changing anything about the droplet;
never build on it. Mechanics and error messages: docs/github-actions-deploy.md.
"Deploy" means: merge the change into `main` and push, run the **Deploy** workflow
(`deploy.yml`, on `main`) through the GitHub Actions tools, and confirm the run
succeeded. The droplet installs the build within about three minutes.

- Claude reaches the droplet only via `ssh lindero-ops <action>` (docs/claude-ops-key.md).
  The second droplet (docs/second-droplet.md) does not serve Lindero yet; Claude only
  reads it, via `ssh lindero-ops-2 <action>`.
- Proof it is live, when the cloud environment allows `lindero.basculacentral.com`:
  `/api/health` answers, and the `/assets/index-*.js` in the live page matches the
  one on `deploy-build`. Screens behind the login need the owner: ask them to check
  rather than claiming more than was verified. A short 502 right after a deploy is
  the restart; recheck for a minute before reporting a problem.
- Never merge `deploy-build` or `deploy-build-test` into anything (built files only).

## The test site

https://prueba-lindero.basculacentral.com: a second Lindero with fake data and an
orange «SITIO DE PRUEBA» strip. "Deploy test" means: run the **Deploy test** workflow
(`deploy-test.yml`, on `main`) with `branch` set, and confirm the run succeeded; it
arrives within about three minutes. Check it as above, against `deploy-build-test`.

- One version at a time, last run wins: tell the owner which branch is on it. `reset_data`
  erases everything there and reseeds: warn the owner first.
- No Google Drive button, and WhatsApp, SMS and mail open with no recipient, on purpose.
- Changes under `deploy/` reach it only after merged and deployed live. Its logins are
  in its `.env`; the owner has them. Never ask for them.

## Fixing things, one at a time (each change easy to identify and to undo)

1. **One fix per branch, from the latest `main`**, named for its purpose and review
   ID, e.g. `fix/p3-1-edit-terms-double-sale`. Cloud sessions get an assigned
   `ccr-...` name; the PR title then carries the purpose.
2. **Prove it.** A test that fails without the fix and passes with it, plus
   `npm run typecheck` and `npm test`, and `npm run test:e2e` (docs/browser-tests.md)
   when the change shows on screen. For speed or memory work, run the **Benchmark**
   workflow (`before: main`, `after: <branch>`); every row must say "Same answer".
3. **One pull request per fix**, titled with the review ID, e.g. "P3-1: Stop «Editar
   términos» from double-selling a lot". Say what was wrong, what changed, how it was
   checked and what the owner should try; attach a phone-sized browser-test screenshot
   for on-screen changes. Never merge one whose **Tests** check is red.
4. **Test site first** for anything the owner will see: Deploy test the branch, say what
   to try, and fix on the same branch and PR until they say it is right. A change that
   shows nothing on screen skips this, and the PR says so.
5. **Merge only when the owner names the PR number**, deploy, and ask them to check
   the real site; start the next fix only after they confirm. If something broke,
   revert the PR (GitHub's Revert button), merge and deploy that. Never rewrite `main`.
6. **Releases mark good versions**, never spare branches. After the owner confirms the
   site, or asks, run the **Release** workflow (`release.yml`; `title` names its contents).

## Cloud sessions and phone habits

1. **Ask before building when the owner asks for an opinion** ("What do you think?"):
   explain and propose first. Anything that decides how money is counted (payment types,
   what is owed next, mora) is the owner's decision: give options and trade-offs, wait.
2. **Run the browser tests in a cloud session too**, though its Chrome is not the one
   Playwright expects: use a temporary, never-committed `playwright.claude-local.config.ts`
   (spread `playwright.config`, set `use.launchOptions.executablePath` to
   `/opt/pw-browsers/chromium`), run it with `npx playwright test -c`, then delete it.
3. **No code formatter over whole files** (Prettier once rewrote hundreds of unrelated
   lines). Edit by hand, in the surrounding style.
