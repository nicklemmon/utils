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
authentication against live GitHub or GitLab servers.
