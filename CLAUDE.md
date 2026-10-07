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
the droplet or the live site, so say that the run succeeded and ask the owner
to check the site, rather than claiming the deploy is live. If it does not
appear, they can run `journalctl -u lindero-autodeploy -n 50` and send a
screenshot. Details: docs/github-actions-deploy.md.

Never merge `deploy-build` into anything; it holds built files only.

## Checks before pushing

`npm run typecheck` and `npm test` from the repository root.
