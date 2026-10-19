# Stryker baseline report

This report measures the four test workspaces from `origin/main` at `7cd9f8a80626bfac67d111ca89be20d8b655d6cc`.

## Results

| Package                       |  Raw score | Displayed score | Candidate `thresholds.break` | Mutants | Killed | Timed out | Survived | No coverage | Runtime |
| ----------------------------- | ---------: | --------------: | ---------------------------: | ------: | -----: | --------: | -------: | ----------: | ------: |
| `@nicklemmon/gh-gl`           |  63.85350% |          63.85% |                        63.85 |     628 |    401 |         0 |       80 |         147 |  3m 30s |
| `@repo/anti-slop`             |  53.43799% |          53.44% |                        53.43 |   3,185 |  1,681 |        21 |      902 |         581 |  1m 21s |
| `@nicklemmon/example`         | 100.00000% |         100.00% |                       100.00 |       2 |      2 |         0 |        0 |           0 |     <1s |
| `@repo/dependency-changesets` |  69.48052% |          69.48% |                        69.48 |     462 |    321 |         0 |       81 |          60 |  1m 08s |

Stryker counts killed and timed-out mutants as detected. Surviving and no-coverage mutants count as undetected. Errors are excluded. The candidate thresholds round each raw score down to two decimal places because Stryker compares the raw score but prints two decimals. The anti-slop baseline is 53.43799%, shown as 53.44%, so `thresholds.break: 53.44` would fail on the current baseline. Use 53.43.

The `example` package produced only two mutants. Its 100% score is a weak baseline. Review its mutation scope before making this floor a required check.

The four runs took about six minutes when run one after another with four workers each.

## Compatibility checks

The project uses Vitest 5.0.3. Stryker 10.0.0's Vitest runner builds per-test filters with a space between nested suite names. Vitest 5 expects `>`. Without that fix, a focused run reported 0% and all 17 `remote-url.ts` mutants survived. Applying the same separator fix from [Stryker PR #6214](https://github.com/stryker-mutator/stryker-js/pull/6214) made the focused score 88.24% (15 of 17 mutants killed). The PR remains open. Each `test:mutation` command applies this fix before Stryker runs. This explicit step is needed because `.npmrc` disables install scripts. The workflow also checks a known `isHttpsRemote` mutation. Remove the patch and temporary canary after a released runner includes the fix.

Stryker's TypeScript config preprocessor calls an API removed from TypeScript 7. A scoped TypeScript 6 dependency under Stryker did not provide a reliable package-managed setup, so the CI draft uses TypeScript 6.0.3 at the workspace root. This follows the approved fallback.

The draft was revalidated on TypeScript 6.0.3 with the runner patch. All four packages passed their candidate floors. The scores were 63.85% for `gh-gl`, 53.44% for `anti-slop`, 100.00% for `example`, and 69.48% for `dependency-changesets`. The `isHttpsRemote` canary passed. The root `check-types` task passed on TypeScript 6.0.3. The anti-slop run still had 21 timed-out mutants, as in the baseline.

## CI plan

1. Run a separate mutation workflow on every pull request and main push. Keep it separate from `npm run qa` so its runtime is visible.
2. Start with one matrix job for each of the four packages. Add changed-package selection only if full runs become too slow.
3. Set each package's Stryker `thresholds.break` to its reviewed baseline floor. Raise floors in follow-up changes when tests improve. Do not lower a floor without a documented reason.
4. Upload each run's HTML and JSON reports as workflow artifacts. Show the package score and floor in the job summary.
5. Keep the workflow informational during rollout. Do not make the job a required branch check until the temporary runner patch and canary are no longer needed.
6. Remove the runner patch and temporary `isHttpsRemote` canary after the released runner supports Vitest 5. Consider incremental caching and a scheduled full run after measuring CI runtime.

The HTML and JSON reports are generated outputs. The CI workflow uploads them as artifacts for each run.
