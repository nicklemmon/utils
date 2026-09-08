/** What a `gh-gl sync` run did, in enough detail to report to the caller. */
export type SyncOutcome =
  | {
      kind: "no-op";
      branch: string;
      githubSha: string;
      overlayFingerprint: string;
    }
  | {
      kind: "rebuilt";
      branch: string;
      githubSha: string;
      overlayFingerprint: string;
      dryRun: boolean;
    }
  | { kind: "merged"; branch: string; dryRun: boolean }
  | {
      kind: "conflict";
      branch: string;
      conflictingFiles: ReadonlyArray<string>;
      gitlabUrl: string;
      gitlabDefaultBranch: string;
    };

/**
 * Map a sync outcome to the CLI's exit code.
 *
 * `no-op`, `rebuilt`, and `merged` all succeed with `0` — the repo ends in the correct state either
 * way. `conflict` is `1`, a non-bug outcome that needs a human. Real errors (bad auth, invalid
 * input, unexpected git failures) are thrown as exceptions and map to `2` at the CLI boundary.
 *
 * @param outcome - Sync result to translate into an exit code.
 * @returns `0` for success kinds, or `1` for `conflict`.
 */
export function exitCodeForOutcome(outcome: Readonly<SyncOutcome>): number {
  return outcome.kind === "conflict" ? 1 : 0;
}

function formatOutcomeAsText(outcome: Readonly<SyncOutcome>): string {
  switch (outcome.kind) {
    case "no-op":
      return `${outcome.branch} is already up to date (no-op).`;
    case "rebuilt":
      return outcome.dryRun
        ? `${outcome.branch} would be rebuilt from GitHub's default branch and the overlay (dry run, nothing pushed).`
        : `${outcome.branch} rebuilt from GitHub's default branch and the overlay.`;
    case "merged":
      return outcome.dryRun
        ? `${outcome.branch} would merge cleanly (dry run, nothing pushed).`
        : `${outcome.branch} merged cleanly.`;
    case "conflict":
      return [
        `${outcome.branch} has a merge conflict and needs a human:`,
        ...outcome.conflictingFiles.map((file) => `  ${file}`),
        "",
        "To finish this locally:",
        `  git fetch ${outcome.gitlabUrl} ${outcome.gitlabDefaultBranch}`,
        `  git checkout ${outcome.branch}`,
        "  git merge --no-ff FETCH_HEAD",
        "  # resolve the conflicting files listed above, then:",
        `  git push ${outcome.gitlabUrl} ${outcome.branch}`,
      ].join("\n");
    default: {
      const exhaustive: never = outcome;

      throw new Error(`Unhandled sync outcome kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Render a sync outcome for the CLI's stdout.
 *
 * @param outcome - Sync result to print.
 * @param options - When `json` is true, emit one JSON object instead of human-readable text.
 * @returns A single text block or JSON object string for stdout.
 */
export function formatOutcome(
  outcome: Readonly<SyncOutcome>,
  options: Readonly<{ json: boolean }>,
): string {
  return options.json ? JSON.stringify(outcome) : formatOutcomeAsText(outcome);
}
