/** The `gh-gl`-owned sync state, read from and written to git commit trailers. */
export type SyncTrailers = {
  githubSha: string;
  overlayFingerprint: string;
};

/**
 * Read `Synced-from-github` and `Synced-from-overlay` trailers out of a commit message.
 *
 * @param message - Full commit message body, including any trailer block.
 * @returns Parsed trailer values, or `undefined` when either trailer line is missing.
 */
export function parseSyncTrailers(message: string): SyncTrailers | undefined {
  const githubMatch = /^Synced-from-github: (.+)$/mu.exec(message);
  const overlayMatch = /^Synced-from-overlay: (.+)$/mu.exec(message);
  const githubSha = githubMatch === null ? undefined : githubMatch[1];
  const overlayFingerprint = overlayMatch === null ? undefined : overlayMatch[1];

  if (githubSha === undefined || overlayFingerprint === undefined) {
    return undefined;
  }

  return { githubSha, overlayFingerprint };
}

/**
 * Render `trailers` as commit-message trailer lines for appending to a commit message body.
 *
 * @param trailers - Sync state written into the next rebuild commit.
 * @returns Two trailer lines joined by a newline, without a trailing blank line.
 */
export function formatSyncTrailers(trailers: Readonly<SyncTrailers>): string {
  return `Synced-from-github: ${trailers.githubSha}\nSynced-from-overlay: ${trailers.overlayFingerprint}`;
}
