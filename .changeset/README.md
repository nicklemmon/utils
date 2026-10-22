# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to version packages and write changelogs.

## Dependabot updates

The workflow generates a patch changeset for runtime dependency updates to public packages.
It skips development dependencies, GitHub Actions, lockfile-only changes, private packages, and configured ignore patterns.
Review peer dependency changes, dependency additions or removals, and package identity changes manually.
The workflow reserves `.changeset/dependabot-<PR number>.md`. It updates or removes this file and leaves other changesets alone.
It reads the PR manifests through GitHub's API and runs the generator from `main`. It does not execute PR code.
Before publishing, it checks that the PR head has not changed. Failed writes are not retried; rerun the workflow.

### Configure the GitHub App

Install a GitHub App with **Contents: read and write** and **Pull requests: read** access.
Set `DEPENDENCY_CHANGESETS_APP_ID` as an Actions variable and `DEPENDENCY_CHANGESETS_APP_PRIVATE_KEY` as an Actions secret.
The workflow uses the App only when it needs to commit a changeset. Keep `qa` required and require branches to be up to date.
Runtime updates that need a changeset wait if App credentials are missing. Other updates can continue.
The existing auto-merge policy still checks Dependabot metadata, and `qa` verifies the generated changeset.

### Process an existing PR

After the workflow lands on `main`, preview an existing PR:

```bash
gh workflow run dependabot-changesets.yml -f pr-number=40 -f preview=true
```

Review the plan in the workflow log. To publish it:

```bash
gh workflow run dependabot-changesets.yml -f pr-number=40 -f preview=false
```

Preview locally with a repository read token in `GH_TOKEN`:

```bash
GITHUB_REPOSITORY=nicklemmon/utils PR_NUMBER=40 CHANGESET_MODE=preview \
  npm run --silent generate --workspace=@repo/dependency-changesets
```

Preview is the default. Set `CHANGESET_MODE=publish` with Contents write access to publish, or use `check` to fail when the file is stale. Check mode never writes.

## Manual changesets

```bash
npm run changesets:add
```

After changesets land on `main`, the Release workflow opens a Version Packages PR. Merging that PR bumps versions and changelogs. A separate publish job then waits for approval in the `npm-publish` GitHub Environment before publishing with Trusted Publishing (OIDC).

If you reject or cancel that approval, re-run the Release workflow when you are ready to publish. Avoid merging other commits to `main` while a publish is waiting.

For a local version bump without publishing:

```bash
npm run changesets:version
```

For a local publish (bootstrap or debug only; prefer CI after Trusted Publishing is configured):

```bash
npm run changesets:publish
```
