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
the droplet. It can reach the live site only when the cloud environment allows
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
   with it, plus `npm run typecheck` and `npm test`. For speed or memory work,
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

Branches are deleted after merge (the repository deletes them automatically
once that setting is on), so the branch list stays `main` and `deploy-build`.
Do not keep branches as backups: `main`'s history and the releases already are.

## Checks before pushing

`npm run typecheck` and `npm test` from the repository root. The **Tests**
workflow (`.github/workflows/tests.yml`) runs them, plus a build, on every pull
request; do not merge one whose check is red.
