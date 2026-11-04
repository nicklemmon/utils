# gh-gl design

This document tracks the current implementation for maintainers. Update it when
the design or its guarantees change. For install steps, command options,
authentication setup, and user-visible outcomes, see [README.md](./README.md).

## Scope

One `gh-gl sync` run targets one GitLab branch. It detects the default branch
for both remotes with `git ls-remote --symref`; it does not call either host's
REST API.

The target branch selects the operation:

- The GitLab default branch is rebuilt from GitHub's default branch and the
  local overlay.
- Any other target branch receives a real Git merge from the GitLab default
  branch. It keeps its own history and commits.

GitHub is the source of truth. The GitLab default branch is machine-managed.
People should not commit to it by hand. The sync process rebuilds it.

## Runtime boundaries

The published `gh-gl` command starts at `cli.ts`. This small shim locates the
package's varlock executable and runs `cli-impl.ts` with `varlock run --path`
pointing at the installed package. This lets varlock load the package's
`.env.schema` even when the caller runs the command from another directory.
`cli-impl.ts` validates the command flags, reads tokens from varlock, checks
which HTTPS remotes need tokens, calls `sync`, and formats the outcome.

The shim exists because `varlock/env` does not parse `.env.schema`. It only
reads the resolved values that `varlock run` puts in the child environment as
`__VARLOCK_ENV`. `varlock run` reads `.env.schema` from the working directory
and does not search parent directories. The shim resolves the `varlock`
executable from the installed package, not from `PATH`, because a global
install can omit it from `PATH`. The cost is a second Node process per run. We
accept this cost. It keeps schema lookup independent of the caller's working
directory, and it does not depend on varlock's internal `loadEnvGraph` API.

### Authentication

GitHub and GitLab each use HTTPS or SSH. Each remote selects its scheme from
its own URL.

`.env.schema` marks `GITHUB_TOKEN` and `GITLAB_TOKEN` as `@sensitive` and
`@optional`. Varlock masks both values. A static schema cannot express which
token is required, because that depends on the URL scheme. `cli-impl.ts` checks
this after it parses the URLs. An HTTPS remote without its token fails with an
error that names the missing variable and the flag that requires it. An SSH
remote never requires a token.

HTTPS remotes use temporary `GIT_ASKPASS` helpers. Each token is passed to Git
through the child process environment. The token is not written to the helper
script, a remote URL, command arguments, or Git configuration. SSH remotes use
the caller's normal SSH setup. A sync run owns its helpers and removes them
after all Git work finishes.

Git operations use the installed `git` command through `execa`. This keeps
merge and conflict behavior consistent with Git commands people run locally.
There is no host API client.

## Default branch rebuild

The rebuild uses Git commit trailers as its only persistent sync state:

- `Synced-from-github` stores the GitHub commit SHA.
- `Synced-from-overlay` stores the overlay tree hash.

For each attempt, `gh-gl` fetches the current GitLab branch and reads its
trailers. It then shallow-fetches GitHub's default branch and captures the local
overlay. If both captured values match the trailers, the run is a no-op.

Otherwise, the run extracts GitHub's tree into a fresh scratch repository with
`git archive` and `tar`. It applies the captured overlay, stages the resulting
tree, writes the new trailers in a commit, and pushes that commit to GitLab.

The commit contains the paths that `git archive` extracts. The base index starts
as the GitHub tree. The rebuild removes each path that the archive omits: paths
with the `export-ignore` attribute and all gitlinks (submodules). Files with the
`export-subst` attribute get their expanded content. All other upstream paths
keep their exact GitHub blob IDs and modes, so upstream `.gitattributes` line
ending rules and filters do not change their bytes. Upstream `.gitignore` rules
do not remove tracked upstream files. Git LFS pointer files are committed as
pointer files.
The default branch is rebuilt because its tree has no human-owned changes to
preserve.

A non-fast-forward push rejection starts one new attempt from a fresh scratch
repository. The retry fetches both inputs and captures the overlay again. A
second rejected push fails the run. Other push errors fail immediately. A dry
run still detects branches, fetches GitHub, captures the overlay, and checks
whether a rebuild is needed. It does not create the bootstrap commit, rebuild
commit, or push.

### Overlay snapshot

The overlay can be any local directory. Capture walks it once and stores
regular files and symlink targets as Git blobs. It records executable mode and
symlink mode. Paths named `.git` are excluded at every directory level. Git
ignore rules and filters do not affect capture. Other filesystem entry types
are skipped.

An isolated Git index turns the captured entries into a tree. Its hash is the
fingerprint. The rebuild applies those same captured blobs and modes to the
GitHub tree and stages those exact objects in the commit index. Overlay paths
replace upstream paths. A source change after capture therefore does not make
the fingerprint differ from the files staged by that attempt. Capture is not an
atomic filesystem snapshot; the overlay must stay stable while capture runs. A
retry makes a new capture.

An overlay file can be any file in the directory, including files that a
`.gitignore` matches, such as `.env` or `.DS_Store`. Do not keep secrets or
local files in the overlay directory.

The overlay is a local directory path. `gh-gl` does not know its origin. One
convention is to keep the overlay source on a dedicated branch of the private
GitLab repo, such as `overlay-source`, so that changes get merge request review.

## Prototype branch merge

The merge path fetches the target branch and the current GitLab default branch
with their history. It checks out the target and runs `git merge --no-ff` with
the default branch. A clean merge is pushed unless this is a dry run.

On a conflict, `gh-gl` records the conflicting paths, aborts the merge, and
pushes nothing. The CLI gives the person commands to fetch and complete the
merge locally. It does not choose conflict resolutions. A rejected push fails
the run and is not retried because the computed merge may no longer apply to
the remote branch.

## Empty repositories

GitHub must have a commit on its default branch. Without one, there is no
source tree to sync, so the run fails.

When GitLab has no default branch, a normal run pushes an empty bootstrap commit
to a branch with GitHub's default branch name, then performs the rebuild. If
that push loses a race, `gh-gl` checks GitLab's default branch again. A dry run
does not bootstrap GitLab. A requested prototype branch cannot be created by
the sync process; it must already exist along with the GitLab default branch.

## Operational assumptions

`gh-gl` depends on these conditions. It does not enforce them.

- GitLab branch protection blocks direct human pushes to the default branch.
  The rebuild discards any commit that is not a sync commit.
- Two runs do not sync the same branch at the same time. The rebuild retry
  handles one transient race. It is not designed for continuous concurrent
  writers.

## Exit codes

Exit code `0` covers both a pushed change and a no-op. Both mean that the branch
is in the correct state. A scheduled no-op is the most common run, and CI
systems treat any other code as a failure. Code `1` is a merge conflict that
needs a person. Code `2` is any other error. Output content carries more detail;
`--json` prints it as one object.

## Resource ownership and limits

Each scratch operation creates a fresh repository under the operating system's
temporary directory. The owner removes it on success and failure,
including when initialization fails. If both the operation and cleanup fail,
the reported error keeps both failures. The askpass helpers live across the
whole sync run and are cleaned up in reverse creation order.

The rebuild path can recover from one concurrent non-fast-forward push. It
does not retry indefinitely. The merge path reports a rejected push as an
error. GitLab Pages deployment stays in the overlay's `.gitlab-ci.yml`; the
CLI does not manage deployments.

The package tests use real local Git repositories to exercise rebuilds,
merges, dry runs, push races, and conflict cleanup. They do not verify
authentication against live GitHub or GitLab servers. No automated test runs
the built `dist/cli.js` through a real `varlock run` subprocess. Unit tests
cover the token checks. The varlock wiring was verified by hand.
