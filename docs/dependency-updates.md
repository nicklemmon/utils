# Dependency updates

Playbook for keeping this monorepo's dependencies small, current, and safe.

Audience: maintainers of `@nicklemmon/utils`. Update this file when the process changes.

## Goals

1. Merge security fixes fast (hours to a day, not weeks).
2. Keep routine version bumps low-noise and reviewable.
3. Prefer removing a dependency over updating it forever.
4. Keep the published runtime surface small. Tooling risk stays in `devDependencies`.

## Current posture (this repo)

| Control | Status |
| --- | --- |
| Dependabot version updates (npm + Actions) | On — weekly, grouped, 7-day cooldown |
| Dependabot security updates | On (repo Settings → Code security) |
| Dependabot auto-merge | On — patch PRs via `.github/workflows/dependabot-auto-merge.yml` (GitHub-documented pattern) |
| CI gate | `npm run qa` includes `npm audit --audit-level=high` |
| Actions supply chain | SHA-pinned actions; `zizmor` + `actionlint` on PRs |
| Publish path | npm Trusted Publishing (OIDC); no long-lived `NPM_TOKEN` |
| Ownership | Solo (`CODEOWNERS`: `@nicklemmon`) |

Runtime production deps today are small: `zod`, `commander`, `execa`, `varlock`, plus `@oxlint/plugins` in the private lint package. Most of the lockfile is toolchain.

## Principles

### 1. Treat security updates as a different lane

Dependabot **security** updates open when a fixed advisory lands. They do **not** wait on your weekly schedule or the version-update cooldown.

Do not fold security fixes into a slow monthly batch. Keep them as their own PRs (or a security-only group) so they stay visible and mergeable.

### 2. Keep a cooldown on routine version bumps

The 7-day cooldown on version updates is intentional. It reduces the chance of pulling a brand-new malicious release before the ecosystem notices it.

Do not remove cooldown to "go faster" on security. Security updates already bypass it.

### 3. Smallest useful dependency set

Every direct dependency is a forever cost: advisories, majors, transitive noise, and review time.

Before adding a package, ask:

- Can Node, TypeScript, or an existing dep do this?
- Is this a runtime need, or only a build/test need? Put tooling in `devDependencies`.
- Will consumers of a published `@nicklemmon/*` package need this at runtime? If yes, it belongs in that package's `dependencies`.

### 4. Green CI is the merge bar for patches

For patch and most minor bumps, trust `qa` + `zizmor`. Spend human review on majors, new packages, and anything that changes auth, publish, or install scripts.

## Operating model

### Security fixes (aggressive)

| Severity | Target merge time | Merge style |
| --- | --- | --- |
| Critical / High | Same day when possible; within 24h | Merge as soon as CI is green |
| Moderate | Within a few days | Merge with the next review pass |
| Low / informational | Next routine bump cycle | Bundle or defer if noisy |

Steps:

1. Open or accept the Dependabot security PR (or bump manually if no PR yet).
2. Confirm `qa` and workflow checks pass.
3. Skim the advisory: is the vulnerable code on our path? Still merge the fix either way when the bump is safe; path analysis only ranks urgency.
4. Merge. Do not wait to batch with unrelated version bumps.
5. If the fix needs a major bump, open a focused PR and treat it as a security exception to the "majors are slow" rule.

Repo settings to keep on:

- Dependabot alerts
- Dependabot security updates
- (Optional) private vulnerability reporting — already documented in `SECURITY.md`

### Routine version updates (calm)

Current Dependabot shape in `.github/dependabot.yml`:

- Weekly npm + GitHub Actions checks
- Production and development groups (fewer PRs)
- 7-day package cooldown on version updates
- Open PR limit 10

Review checklist for a version-update PR:

1. CI green (`qa`, `zizmor`).
2. Changelog / release notes for anything in the group that touches runtime behavior.
3. Lockfile-only noise is fine; do not hand-edit `package-lock.json`.
4. Majors: prefer a dedicated PR, not a mixed group, when the bump can break APIs or config.

### Auto-merge (wired)

Follows GitHub’s documented pattern:
[Automating Dependabot with GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions).

Dependabot **patch** PRs get `gh pr merge --auto --squash`. GitHub merges them only after required status checks pass.

**Auto-merged when all of these hold:**

- Author is `dependabot[bot]`
- Update type is `version-update:semver-patch`
- Required checks are green: `qa`, `actionlint`, `zizmor`

**Not auto-merged (manual review):**

- Semver minor or major version bumps
- Non-Dependabot PRs
- Anything that fails required checks

Most Dependabot **security** fixes are patches, so they auto-merge under the same rule. A security fix that needs a minor or major bump stays manual.

#### Exact wiring

1. **Repo setting:** `allow_auto_merge` is enabled.
2. **Ruleset `Protect main`:** requires status checks `qa`, `actionlint`, `zizmor`. This is the merge gate.
3. **Ruleset `Require reviews except admins`:** **disabled**. Required reviews blocked Dependabot auto-merge, and GitHub has no “exclude Dependabot by author” ruleset option. Re-enable later if you want human review gating again (you would then also need GitHub’s documented auto-approve step, or a code-owner PAT).
4. **Workflow:** `.github/workflows/dependabot-auto-merge.yml`
   - Trigger: `pull_request` (as in GitHub’s example)
   - `dependabot/fetch-metadata` + `gh pr merge --auto --squash` for patches only
   - Workflow `permissions` raise the Dependabot-triggered token from read-only to `contents: write` and `pull-requests: write` ([docs](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions#changing-github_token-permissions))

## Dependency removal audit

Run a removal pass on a fixed cadence (suggested: every quarter, or when the lockfile feels heavy).

### What to look for

1. **Unused direct deps** — declared but never imported or referenced by scripts.
2. **Overlapping tools** — two packages that solve the same problem.
3. **Heavy runtime deps with thin use** — replace with a small local helper if the used surface is tiny.
4. **Transitive bloat driven by one direct dep** — sometimes removing or swapping one direct dep deletes a large subtree.
5. **Example / private packages** — keep `@nicklemmon/example` and `@repo/*` honest; do not let demo-only deps leak into published packages.

### How to run the pass

```bash
# Inventory direct deps
npm ls --depth=0

# Runtime tree only (what published packages + workspace prod deps pull in)
npm ls --all --omit=dev

# Advisory gate (also part of qa)
npm run audit
```

Optional helpers (add only if you will keep them):

- [Knip](https://github.com/webpro/knip) for unused files, exports, and dependencies
- `npm outdated` for a human-readable drift view

For each removal candidate:

1. Delete the dependency from the relevant `package.json`.
2. Remove imports / config that referenced it.
3. Run `npm install` and `npm run qa`.
4. Ship in its own PR titled for the removal (easy to revert).

### Candidates to revisit in this repo

Revisit these when doing a removal pass. This is not a mandate to delete them today.

| Package | Why revisit |
| --- | --- |
| `execa` | Large helper surface; weigh against `node:child_process` if usage stays narrow |
| `varlock` | Native helpers + extra moving parts; confirm the env/schema value still pays for itself |
| `commander` | Fine if the CLI grows; overkill if flags stay tiny |
| Root toolchain pins | Prefer workspace `*` for internal packages; avoid duplicate semver ranges across packages |

## Adding a dependency

1. Prefer packages with clear maintainership, lockfiles in their own CI, and a recent release cadence.
2. Put it in the correct package (`dependencies` vs `devDependencies`).
3. Add the minimum version range you need (`^` is fine; avoid unbounded `*` for external packages).
4. Run `npm install` and `npm run qa`.
5. Note why it exists in the PR body (one or two sentences). Future removal audits use that.

## CI and alerts

- Keep `npm run audit` inside `qa`. Do not weaken `--audit-level=high` without a written exception.
- If `npm audit` fails on a transitive finding with no release yet, prefer an override only with a linked advisory and a removal date. Revisit overrides every release cycle.
- Watch GitHub Dependabot alerts on the repo (email or UI). Alerts without a PR still need a ticket or same-week manual bump.

## What good looks like

- Security PRs merge within a day when CI is green.
- Weekly version-update groups stay small enough to review in one sitting.
- Runtime `npm ls --omit=dev` stays obvious: a short tree, not a novel.
- No dependency sits unused for a full quarter.
- Cooldown remains on version updates; security lane stays separate and fast.

## Out of scope (for now)

- Migrating from Dependabot to Renovate (revisit only if grouping, auto-merge, or monorepo controls become painful)
- Paying for a separate SCA product (revisit if the published surface or org size grows)
- Pinning every npm package to exact versions without a range (lockfile already pins installs)

## Change log

| Date | Change |
| --- | --- |
| 2026-03-22 | Initial playbook from current Dependabot + QA setup |
| 2026-09-21 | Wire Dependabot patch auto-merge (GitHub-documented pattern); disable review ruleset so status checks are the gate |
