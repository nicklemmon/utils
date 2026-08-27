# gh-gl: GitHub → GitLab sync CLI

## Goal

Sync a GitHub repo's default branch into a private, downstream GitLab repo. Layer
GitLab-specific configuration (`.gitlab-ci.yml`, extra code) on top of the synced
content. Let team members create private prototype branches in the GitLab repo
that stay up to date with GitHub, without losing their own commits. GitLab Pages
deploys per branch, entirely via the layered `.gitlab-ci.yml` — no CLI involvement.

## Domain model

**Two repos:**
- GitHub repo — source of truth, public or private, the team's normal workflow.
- GitLab repo — private, downstream. Holds a machine-managed default branch, plus
  any number of human-owned prototype branches, plus a dedicated branch that holds
  overlay content.

**Two kinds of branches inside the GitLab repo:**
- **Default branch** (same name as GitHub's default branch, e.g. `main`) — fully
  machine-managed. No one commits to it by hand. Its tree is always exactly
  `GitHub's tree + overlay content on top`. Rebuilt from scratch on every sync.
- **Prototype branches** — created by team members off the default branch (or off
  each other). Ordinary human-authored git history. Updated by merging the default
  branch in, never rebuilt.

**Overlay** — a directory of GitLab-specific files (`.gitlab-ci.yml`, extra code)
that gets copied on top of GitHub's tree when rebuilding the default branch.
Overlay files always win on path collision; no merge logic, no exclusion list for
upstream files in v1. One overlay per GitHub↔GitLab pairing (no cross-project
reuse). The CLI treats the overlay purely as **a local directory path** — it does
not care where that directory came from. The recommended convention is to keep the
overlay's source on its own dedicated branch (e.g. `overlay-source`) inside the
GitLab repo itself, since the repo is already private and gets normal MR review —
but this is a convention for whoever wires the CLI up, not something the CLI knows
about.

## Package

- `@nicklemmon/gh-gl`, at `packages/gh-gl`, scaffolded like `packages/example`
  (tsdown build, vitest, TypeScript, oxlint conventions from `AGENTS.md`).
- Binary name: `gh-gl`, built from two entry points: `cli.ts` (thin shim that
  re-execs under `varlock run`) and `cli-impl.ts` (the real `commander` program).
  See **Auth → Schema resolution** for why the shim exists.
- CLI framework: `commander`.
- Env var schema: `varlock` (`.env.schema`), not Zod — see **Auth** below.

## Command

One command: `gh-gl sync`

| Flag | Required | Notes |
|---|---|---|
| `--github-url <url>` | yes | Full git remote URL for the source repo. |
| `--gitlab-url <url>` | yes | Full git remote URL for the target repo. |
| `--overlay <path>` | yes | Local directory to layer on top of GitHub's tree. |
| `--branch <name>` | no | Target branch. Defaults to the GitLab repo's auto-detected default branch. |
| `--dry-run` | no | Run the full logic, skip the final commit/push. Reports what would happen. |
| `--json` | no | Emit one JSON object to stdout instead of human-readable text. |

**Path selection rule:** if the resolved `--branch` value (explicit or defaulted)
equals the auto-detected default branch name, run the **rebuild path**. Otherwise,
run the **merge path**. This is a content-based check, not a "flag present or
absent" check — explicitly passing `--branch main` when `main` is the real default
branch still triggers rebuild, not a self-merge no-op.

Full URLs (not `owner/repo` shorthand) so self-hosted GitLab works identically to
gitlab.com, with no platform-specific parsing.

**Scope: one invocation, one branch.** `gh-gl sync` operates on exactly one target
branch per run. Discovering the full set of prototype branches, deciding the order
to sync them in, and handling partial failure across many branches is a wrapper's
job (a script, a CI matrix, a scheduled job) — not something this CLI does.

## Default branch detection

`git ls-remote --symref <url> HEAD` against each repo — no GitHub/GitLab REST API
call anywhere in the tool. This is the same underlying mechanism both platforms
use to implement their own "default branch" setting, so it agrees with the API in
every case that matters.

**Precondition: the GitLab repo must already have a commit on its default branch
before the first sync.** An empty repo has no resolvable `HEAD` for `ls-remote` to
report. Bootstrapping an empty GitLab repo is explicitly out of scope for v1 — seed
it with at least one commit (even an empty initial commit) before running `gh-gl
sync` against it for the first time. The CLI fails with a clear error naming this
precondition if `ls-remote` can't resolve `HEAD` on either remote.

## Auth

**Transport:** both HTTPS and SSH remote URLs are supported, per-remote (GitHub and
GitLab can each use either scheme independently).

- **HTTPS remotes** authenticate via `GIT_ASKPASS`: for each `execa` git call
  against an HTTPS remote, the CLI sets a scoped env var (e.g. `GIT_ASKPASS_TOKEN`)
  to the token that call needs, and points `GIT_ASKPASS` at one small shared helper
  script that just echoes it. The token never appears in a URL, in argv, or in any
  git config file. This works identically for GitHub and GitLab — `GIT_ASKPASS` is
  a generic git mechanism, not platform-specific.
- **SSH remotes** authenticate via the ambient SSH agent/keys already available in
  the environment the CLI runs in. The CLI does not manage SSH keys, does not set
  `GIT_ASKPASS`, and does not need a token for that remote at all — it just invokes
  `git` and lets SSH do what it already does on that machine.

**Tokens are conditionally required, not statically required.** `.env.schema`
declares `GITHUB_TOKEN` and `GITLAB_TOKEN` as `@sensitive` but *not* `@required` —
varlock still owns masking/redaction for both, but whether a given token is needed
depends on a runtime value (the URL scheme in `--github-url`/`--gitlab-url`), which
a static schema can't express. The CLI checks this after parsing the URLs: any
HTTPS remote whose matching token is missing fails with a clear error naming the
missing env var and which flag caused it to be required. An SSH remote never
requires its token.

```
if (isHttps(githubUrl) && !ENV.GITHUB_TOKEN) {
  error("GITHUB_TOKEN is required when --github-url is HTTPS")
}
```

**Schema resolution:** varlock's `ENV` object (`varlock/env`) does not parse
`.env.schema` itself — it only reads an already-resolved env blob
(`__VARLOCK_ENV`) that the separate `varlock` CLI injects into a child process via
`varlock run`. varlock reads `.env.schema` from the current working directory by
default and does not search parent directories, so a plain `gh-gl` invocation from
an arbitrary working directory (a CI job, a wrapper script, anywhere) would not
find the schema bundled inside the installed package.

`packages/gh-gl`'s published `bin` entry is therefore a thin shim, not the CLI
itself:

1. `bin` → `dist/cli.js`. On start, it resolves its own package directory (via
   `import.meta.url`) — this is where `.env.schema` and the real implementation
   (`dist/cli-impl.js`) live.
2. It re-execs itself as a child process:
   `varlock run --path <package-dir> -- node <package-dir>/dist/cli-impl.js <argv>`,
   resolving `varlock`'s own executable path explicitly (not via `PATH`, which
   isn't guaranteed to include it for a global install).
3. `varlock run --path` resolves `.env.schema` from the explicit path, validates
   it, and injects the result into the child's env as `__VARLOCK_ENV`.
4. `dist/cli-impl.js` — the actual `commander` program — runs as that child and
   reads `ENV` from `varlock/env` normally.

This costs a second node process per invocation. Accepted: `gh-gl` already shells
out to `git` repeatedly per run, so one more process start is not the dominant
cost, and it keeps schema resolution independent of the caller's cwd without
depending on `varlock`'s internal (non-public) `loadEnvGraph` API.

Non-secret config (`--overlay`, `--github-url`, `--gitlab-url`, `--branch`) stays
as CLI flags for now. Config-file support is a possible later addition, not v1.

## Git operations

Shell out to the real `git` binary via `execa`. Not a JS git library. Reasons:
merge/conflict behavior must match exactly what a person sees running `git merge`
locally (since conflict recovery instructions tell them to do exactly that); every
environment this runs in (GitHub Actions, GitLab CI, a laptop) already has `git`
installed.

## Rebuild path (default branch)

1. Fetch GitHub's tree at its default branch, shallow (`depth=1`) — no history
   needed.
2. Fetch the GitLab default branch's current tip commit.
3. Read `Synced-from-github: <sha>` and `Synced-from-overlay: <hash>` trailers out
   of that tip commit's message. This is the tool's only state — no external
   database or state file. The sync cursor lives inside the GitLab repo's own git
   history.
4. Compute the current GitHub HEAD SHA and the current overlay fingerprint (see
   below).
5. **No-op check:** if both match the trailer values, stop — nothing to do.
6. Otherwise, in a scratch working directory: clear it, extract GitHub's tree into
   it via `git archive <ref> | tar -x` (not a plain filesystem copy — this
   preserves file modes and symlinks instead of silently flattening them), then
   copy the overlay directory on top (overlay always wins on path collision, by
   construction — no merge logic). Git submodules and Git LFS pointer files inside
   GitHub's tree are copied through as literal files, unresolved — out of scope for
   v1.
7. Commit the result onto the GitLab default branch, with the new
   `Synced-from-github` / `Synced-from-overlay` trailers in the message.
8. Push. (Skip commit + push under `--dry-run`; report what would have happened
   instead.) **If the push is rejected as non-fast-forward** (e.g. a concurrent
   sync run won the race): re-fetch the GitLab tip, re-read its trailers, and redo
   steps 4–8 exactly once. If the retry's push is also rejected, stop and exit `2`
   — no further retries. This handles the common transient race (two scheduled
   runs overlapping) without turning the CLI into a general-purpose retry loop.

**Why wipe-and-rebuild is safe here:** nobody commits to the default branch by
hand, so there's no independent human history to destroy. The tree is always
exactly `GitHub ∪ overlay`, deterministically, every run.

**Overlay fingerprint:** computed via git plumbing (stage the overlay directory
into a throwaway index, `git write-tree`) rather than assuming the overlay
directory is itself a git checkout with a readable `HEAD`. This keeps the CLI's
"overlay is just a directory, origin unknown" contract intact regardless of how
that directory got onto disk — a git checkout, an extracted archive, anything.

## Merge path (prototype branches)

1. Fetch the GitLab default branch's current tip and the target branch's current
   tip.
2. In a scratch clone, attempt `git merge <default-branch>` into the target
   branch.
3. **Clean merge:** push the result. (Skip the push under `--dry-run`; report that
   it would have merged cleanly.)
4. **Conflict:** abort the merge (`git merge --abort`), push nothing, print the
   conflicting file paths and the exact git commands the person should run locally
   to finish it themselves (fetch, merge, resolve, push). The CLI never attempts
   automatic conflict resolution — these are real human-authored changes on both
   sides, and guessing wrong would silently corrupt someone's work.

No push-retry logic on this path (unlike the rebuild path): a prototype branch has
a single human owner by construction, so the concurrent-writer race the rebuild
path guards against doesn't apply here. A rejected push just means the owner's
local branch is behind — a normal git situation they resolve the normal way.

## Operational assumptions

Things this design depends on that the CLI does not itself enforce:

- **The GitLab default branch is protected against direct human pushes** (e.g. via
  GitLab branch protection rules). The rebuild path's wipe-and-rebuild safety
  assumption — "nobody commits to the default branch by hand" — is a convention
  the operator enforces, not something `gh-gl` checks or defends against.
- **The GitLab repo is pre-seeded** with at least one commit on its default branch
  before the first sync (see **Default branch detection**).
- **Syncs for a given branch are not run concurrently** from two different
  invocations. The rebuild path tolerates one transient race via a single retry
  (see **Rebuild path**, step 8); it is not designed for sustained concurrent
  writers.

## Pages deployment

Out of scope for the CLI entirely, v1. GitLab Pages already supports per-branch
deployment natively via `.gitlab-ci.yml` rules — this is purely a matter of how
the overlay's `.gitlab-ci.yml` is authored. The CLI's only job is making sure that
file reaches every branch through the sync/merge flow above. Possible future CLI
expansion (deployment status, cleanup of stale branch deployments) explicitly
deferred.

## Testing

- **Unit tests** — pure logic, no git or filesystem: trailer parsing/formatting,
  conflict-recovery message generation, Zod validation of CLI flags.
- **Integration tests** — real local git repositories on disk standing in for
  GitHub and GitLab. Git doesn't distinguish a local path remote from a real
  GitHub/GitLab URL, so this exercises the actual `git` binary and its actual
  merge algorithm — not a mock. Covers: rebuild no-op vs. rebuild-triggered by
  GitHub change vs. by overlay-only change vs. upstream file deletion; clean merge;
  conflicting merge (abort, no push, correct recovery message); missing/invalid
  env vars producing the varlock-driven error and correct exit code.
- **Explicitly out of automated CI:** the real `GIT_ASKPASS` path against a real
  GitHub/GitLab server — needs real credentials and hosts, verified manually
  during development instead.
- No `vi.mock`/`jest.mock` anywhere, per `AGENTS.md` — and nothing in this design
  needs it. MSW is not used: this tool makes no REST API calls to GitHub or GitLab
  at any point (see **Default branch detection** above), so there's no JSON
  request/response surface for MSW to attach to. Reserve MSW for if/when a real
  REST API call gets added to a future feature.

## Exit codes and output

Three exit code tiers, deliberately coarse — reserved for "does a wrapper need to
*behave differently*," not for every distinction in outcome (richer detail belongs
in output content, not in the exit code):

- **`0`** — success. Covers both "rebuilt/merged and pushed" and "no-op, nothing
  to do." Both mean the repo is now in the correct state. Splitting these into
  different codes would break the standard "0 means success" convention that CI
  systems and shells assume by default (`set -e`, `&&`/`||`, step pass/fail
  checks) — the most common run of this tool is a scheduled no-op, and a naive
  wrapper would show that as a failed pipeline if `0` didn't cover it.
- **`1`** — merge conflict, needs a human. Expected, non-bug outcome on the merge
  path only. A wrapper can special-case this (e.g. notify the branch owner)
  without treating it as broken.
- **`2`** — real error: bad auth, network failure, invalid flags/env vars,
  unexpected git failure.

**Output:** human-readable text by default. A `--json` flag emits one JSON object
to stdout instead — outcome category, branch name, relevant SHAs/hash, and (on
conflict) the list of conflicting file paths — for callers that need to act on the
details rather than just branch on the exit code.

## Scratch directory

Created fresh per run, under the OS temp dir, with a unique name (so concurrent
runs — e.g. two branches syncing in parallel CI jobs — never collide). **Always
deleted when the run finishes, success or failure alike.** No debug-preservation
special case on error: simpler behavior, no disk accumulation on long-lived hosts,
accepted over the (minor) loss of leftover-directory forensics on failure.
