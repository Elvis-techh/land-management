# Working on Lindero

## Who you are working with

The owner is new to programming and often works from a phone. Explain git,
GitHub and deploy concepts (branch, commit, push, pull request, merge, build,
deploy) in plain language the first time they come up in a session, briefly
and without jargon, and say why a step is needed, not just what to type. They
can paste commands into the droplet console but cannot easily copy text out of
it; they share screenshots instead. Never ask for secrets in the chat.

## Deploying

Production is a shared DigitalOcean droplet; read
docs/deployment-shared-droplet.md before changing anything about it. Never
build on the droplet (512 MB, shared with another app).

"Deploy" means: make sure the change is merged into `main` and pushed, then
run the **Deploy** workflow (`.github/workflows/deploy.yml`, on `main`) through
the GitHub Actions tools, and confirm the run succeeded. The workflow runs the
tests, builds with the Google Drive values from the repository variables, and
publishes the result to the `deploy-build` branch. The droplet's
`lindero-autodeploy.timer` picks it up within two minutes. Claude cannot reach
the droplet, except through its locked key once that is set up
(docs/claude-ops-key.md: `ssh lindero-ops <action>`, a fixed list of read-only
checks plus runbook step 9d). It can reach the live site only when the cloud environment allows
`lindero.basculacentral.com`: then check `/api/health`, and that the
`/assets/index-*.js` named in the live page matches the one on `deploy-build`
(that is the proof the new build is live). Screens behind the login still need
the owner, so ask them to check the site rather than claiming more than was
verified. If the build does not appear, they can run
`journalctl -u lindero-autodeploy -n 50` and send a screenshot. Details:
docs/github-actions-deploy.md.

Never merge `deploy-build` into anything; it holds built files only.

## Fixing things, one at a time

The owner wants every change to be easy to identify and easy to undo. Work
through fixes this way, and explain each step briefly the first time:

1. **One fix per branch, started from the latest `main`.** Name it after its
   purpose with the code-review ID when there is one, e.g.
   `fix/p3-1-edit-terms-double-sale`. In cloud sessions the branch name is
   assigned (`ccr-...`) and cannot be chosen; the pull request title then
   carries the purpose.
2. **Prove it before merging.** A test that fails without the fix and passes
   with it, plus `npm run typecheck` and `npm test`, and `npm run test:e2e`
   (docs/browser-tests.md) when the change shows on screen. For speed or memory work,
   run the **Benchmark** workflow (`before: main`, `after: <branch>`) and check
   every row still says "Same answer".
3. **One pull request per fix.** Title starts with the review ID, e.g.
   "P3-1: Stop «Editar términos» from double-selling a lot". The description
   says what was wrong, what changed, how it was checked, and what the owner
   should look at on the site. This is the permanent record of why the change
   exists; the branch is temporary.
4. **Merge, deploy, and ask the owner to check** (see Deploying). Do not start
   the next fix until they confirm the site is fine.
5. **If something broke, revert the pull request** (GitHub's Revert button on
   the merged PR, then merge that and deploy). It undoes that one fix and
   nothing else. Never rewrite `main`'s history.
6. **Mark good versions with a release**, not a branch: once the owner has
   checked the site, suggest a GitHub release on `main` named by date, e.g.
   `v2026.10.09`. Releases are the "known-good" points to come back to.
   Make it with the **Release** workflow (`.github/workflows/release.yml`, on
   `main`, optional `title`); it picks the date name and refuses a red `main`.

Branches are deleted after merge (the repository deletes them automatically
once that setting is on), so the branch list stays `main` and `deploy-build`.
Do not keep branches as backups: `main`'s history and the releases already are.

## Checks before pushing

`npm run typecheck` and `npm test` from the repository root. The **Tests**
workflow (`.github/workflows/tests.yml`) runs them, plus a build, on every pull
request; do not merge one whose check is red.

## Working from a phone or a cloud session

The owner often directs the work from a phone, through a cloud session. These
hold there as much as anywhere:

1. **Ask before building when the owner asks for an opinion.** "What do you
   think?" or "how does this work?" gets an explanation and a proposal first;
   build once they agree. Anything that decides how money is counted (payment
   types, what is owed next, mora) is the owner's decision, never Claude's:
   lay out the options and the trade-off, then wait.
2. **Run the browser tests in a cloud session too.** The container's Chrome
   is not the version Playwright expects, so `npm run test:e2e` fails at
   launch. Do not skip the tests: point them at the installed Chrome with a
   temporary config in the repository root, and delete it afterwards. Never
   commit it.
   ```ts
   // playwright.claude-local.config.ts — temporary, never committed
   import base from "./playwright.config";
   export default { ...base, use: { ...base.use, launchOptions: { executablePath: "/opt/pw-browsers/chromium" } } };
   ```
   then `npx playwright test -c playwright.claude-local.config.ts`.
3. **Do not run a code formatter over whole files.** The repository has no
   formatter set up; running one (Prettier) once rewrote hundreds of unrelated
   lines. Edit by hand, in the surrounding style.
4. **Show the owner what changes on screen.** For a change they will see,
   take a phone-sized screenshot from the browser test and send it with the
   pull request, so they see it before it goes live.
5. **A short 502 right after a deploy is the server restarting.** Check
   `/api/health` again for a minute before reporting a problem.
6. **Releases come after the owner confirms the site**, or when they ask for
   one (to pull `main` on their computer, say). Give the Release workflow a
   title naming what the release contains.
