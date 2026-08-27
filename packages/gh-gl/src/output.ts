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
    };

/**
 * Map a sync outcome to the CLI's exit code. `no-op` and `rebuilt`/`merged`
 * both succeed with code `0` — the repo ends up in the correct state either
 * way. `conflict` is `1`, a non-bug outcome that needs a human. Real errors
 * (bad auth, invalid input, unexpected git failures) are thrown as
 * exceptions, not represented here, and map to code `2` at the CLI boundary.
 *
 * @param outcome - The result of a sync run.
 * @returns The process exit code for `outcome`.
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
      ].join("\n");
    default:
      return outcome;
  }
}

/**
 * Render a sync outcome for the CLI's stdout, as human-readable text or as a
 * single JSON object.
 *
 * @param outcome - The result of a sync run.
 * @param options - `json: true` emits one JSON object instead of text.
 * @returns The formatted output.
 */
export function formatOutcome(
  outcome: Readonly<SyncOutcome>,
  options: Readonly<{ json: boolean }>,
): string {
  return options.json ? JSON.stringify(outcome) : formatOutcomeAsText(outcome);
}
