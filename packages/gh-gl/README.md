# @nicklemmon/gh-gl

`gh-gl` is a command-line tool. It copies the default branch of a GitHub repo
into a GitLab repo. It also adds GitLab-only files, such as
`.gitlab-ci.yml`, on top of the copied files.

Full design details are in [PLAN.md](./PLAN.md).

## What it does

`gh-gl` manages two repos:

- A **GitHub repo**. This is your source of truth.
- A **GitLab repo**. This is a private, downstream copy.

The GitLab repo has two kinds of branches:

- **The default branch.** `gh-gl` fully controls this branch. Do not commit
  to it by hand. `gh-gl` rebuilds it on every run, from the GitHub default
  branch plus your overlay files.
- **Prototype branches.** People create and own these branches. `gh-gl`
  updates a prototype branch with a real `git merge`. It never rebuilds a
  prototype branch.

`gh-gl` runs one of two actions per invocation:

1. **Rebuild** the GitLab default branch. `gh-gl` does this when the target
   branch is the GitLab repo's default branch.
2. **Merge** the GitLab default branch into a prototype branch. `gh-gl` does
   this for any other target branch.

## Install

```sh
npm install --save-dev @nicklemmon/gh-gl
```

## Quick start

Run this command to sync the default branch:

```sh
npx gh-gl sync \
  --github-url https://github.com/your-org/your-repo.git \
  --gitlab-url https://gitlab.com/your-org/your-repo.git \
  --overlay ./gitlab-overlay
```

Run this command to update a prototype branch:

```sh
npx gh-gl sync \
  --github-url https://github.com/your-org/your-repo.git \
  --gitlab-url https://gitlab.com/your-org/your-repo.git \
  --overlay ./gitlab-overlay \
  --branch my-prototype-branch
```

Add `--dry-run` to preview a sync. `gh-gl` does not push any changes during
a dry run.

### Before your first sync

If the GitLab repo is brand new (no commits at all), `gh-gl` bootstraps it
for you: it pushes an empty commit to a branch named after GitHub's default
branch, then rebuilds it normally. No manual setup step is needed.

`gh-gl` only bootstraps GitLab this way. GitHub must already have a commit on
its default branch — there's nothing to sync from an empty GitHub repo.

## Overlay directory

`--overlay` points at a local directory of GitLab-only files, usually a
`.gitlab-ci.yml` plus anything it needs. `gh-gl` copies these files onto
GitHub's tree as-is, on top of a rebuild — it does not validate their
content. An invalid `.gitlab-ci.yml` still gets copied and pushed; GitLab
only reports the problem when it tries to run a pipeline against it.

A `.gitlab-ci.yml` needs at least one runnable job, not just `stages`:

```yaml
stages: [build]

build:
  stage: build
  script:
    - echo "Add your real build steps here"
```

A file with only `stages: [build]` and no job fails every pipeline with
`jobs config should contain at least one visible job`.

## Command reference

`gh-gl` has one command: `sync`.

| Flag                 | Required | What it does                                                             |
| -------------------- | -------- | ------------------------------------------------------------------------ |
| `--github-url <url>` | Yes      | The GitHub repo's git remote URL.                                        |
| `--gitlab-url <url>` | Yes      | The GitLab repo's git remote URL.                                        |
| `--overlay <path>`   | Yes      | A local folder with GitLab-only files to add. See **Overlay directory**. |
| `--branch <name>`    | No       | The branch to sync. Defaults to the GitLab repo's default branch.        |
| `--dry-run`          | No       | Show what would happen. Do not push any changes.                         |
| `--json`             | No       | Print the result as one line of JSON, instead of plain text.             |

Use a full git URL for `--github-url` and `--gitlab-url`. Do not use the
short `owner/repo` form. `gh-gl` supports both `https://` and `ssh://` URLs.

## Authentication

`gh-gl` supports two ways to connect to a remote.

- **SSH.** `gh-gl` uses your machine's normal SSH setup. You do not need to
  set anything else.
- **HTTPS.** `gh-gl` needs an access token. Set the token in an environment
  variable, then run `gh-gl`.

| Environment variable | Required when                   |
| -------------------- | ------------------------------- |
| `GITHUB_TOKEN`       | `--github-url` uses `https://`. |
| `GITLAB_TOKEN`       | `--gitlab-url` uses `https://`. |

`gh-gl` reads these variables through [varlock](https://varlock.dev). Varlock
masks token values in its own output. See
[`.env.schema`](./.env.schema) for the full variable list.

## Exit codes

`gh-gl` uses three exit codes. A wrapper script can check these codes to
decide what to do next.

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Success. The GitLab branch is now in the correct state.         |
| `1`  | Merge conflict. A person must resolve it by hand.               |
| `2`  | An error occurred. Check the error message for the exact cause. |

On a merge conflict, `gh-gl` does not push any changes. It leaves the
prototype branch as it was before the run.

## Programmatic use

You can also call `gh-gl`'s sync logic directly from Node.js code:

```ts
import { sync } from "@nicklemmon/gh-gl";

const outcome = await sync({
  githubUrl: "https://github.com/your-org/your-repo.git",
  gitlabUrl: "https://gitlab.com/your-org/your-repo.git",
  overlayDir: "./gitlab-overlay",
  dryRun: false,
});

console.log(outcome.kind); // "no-op", "rebuilt", "merged", or "conflict"
```

## Limits

- `gh-gl` syncs one branch per run. To sync many prototype branches, run
  `gh-gl` once for each branch.
- `gh-gl` does not create the first commit on an empty GitHub repo. GitHub
  must already have content to sync from (see **Before your first sync**
  above).
- `gh-gl` does not deploy to GitLab Pages. Configure that through your
  overlay's `.gitlab-ci.yml` file instead.

For the full design and the reasoning behind these limits, read
[PLAN.md](./PLAN.md).
