import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  abortMergeConflict,
  checkoutBranch,
  commitAll,
  detectDefaultBranch,
  extractTree,
  fetchRef,
  fingerprintDirectory,
  initScratchRepo,
  mergeRef,
  pushBranch,
  readCommitMessage,
  resolveRef,
  setSymbolicHead,
} from "./git.js";
import { copyOverlayOnto } from "./overlay.js";
import type { SyncOutcome } from "./output.js";
import { formatSyncTrailers, parseSyncTrailers } from "./trailers.js";

/** Inputs for a single `gh-gl sync` run. */
export type SyncOptions = {
  githubUrl: string;
  gitlabUrl: string;
  overlayDir: string;
  branch?: string | undefined;
  dryRun: boolean;
  githubToken?: string | undefined;
  gitlabToken?: string | undefined;
};

type RebuildAttempt = SyncOutcome | { kind: "push-rejected" };

async function attemptRebuild(
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
): Promise<RebuildAttempt> {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

  try {
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, options.gitlabUrl, branch, {
      localRef: `refs/heads/${branch}`,
      token: options.gitlabToken,
    });

    const previousMessage = await readCommitMessage(
      scratchDir,
      `refs/heads/${branch}`,
    );
    const previousTrailers = parseSyncTrailers(previousMessage);

    await fetchRef(scratchDir, options.githubUrl, githubDefaultBranch, {
      shallow: true,
      token: options.githubToken,
    });

    const githubSha = await resolveRef(scratchDir, "FETCH_HEAD");
    const overlayFingerprint = await fingerprintDirectory(
      scratchDir,
      options.overlayDir,
    );

    if (
      previousTrailers !== undefined &&
      previousTrailers.githubSha === githubSha &&
      previousTrailers.overlayFingerprint === overlayFingerprint
    ) {
      return { kind: "no-op", branch, githubSha, overlayFingerprint };
    }

    if (options.dryRun) {
      return { kind: "rebuilt", branch, githubSha, overlayFingerprint };
    }

    await setSymbolicHead(scratchDir, `refs/heads/${branch}`);
    await extractTree(scratchDir, "FETCH_HEAD", scratchDir);
    await copyOverlayOnto(options.overlayDir, scratchDir);

    const trailers = formatSyncTrailers({ githubSha, overlayFingerprint });

    await commitAll(scratchDir, `Sync GitHub into GitLab\n\n${trailers}`);

    const pushed = await pushBranch(
      scratchDir,
      options.gitlabUrl,
      branch,
      options.gitlabToken,
    );

    if (!pushed) {
      return { kind: "push-rejected" };
    }

    return { kind: "rebuilt", branch, githubSha, overlayFingerprint };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Run the rebuild path for `branch`: wipe-and-rebuild it from GitHub's
 * default branch plus the overlay. Retries once, from scratch, if the push
 * is rejected as non-fast-forward (e.g. a concurrent sync run won the race);
 * a second rejection is a real error, not a race to keep retrying.
 *
 * @param options - The sync inputs.
 * @param branch - The GitLab branch being rebuilt (its own default branch).
 * @param githubDefaultBranch - GitHub's default branch name.
 * @returns What happened.
 */
async function runRebuild(
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
): Promise<SyncOutcome> {
  const first = await attemptRebuild(options, branch, githubDefaultBranch);

  if (first.kind !== "push-rejected") {
    return first;
  }

  const retry = await attemptRebuild(options, branch, githubDefaultBranch);

  if (retry.kind === "push-rejected") {
    throw new Error(
      `Push to ${branch} was rejected twice in a row; another sync run may be in progress.`,
    );
  }

  return retry;
}

async function runMerge(
  scratchDir: string,
  options: Readonly<SyncOptions>,
  branch: string,
  gitlabDefaultBranch: string,
): Promise<SyncOutcome> {
  await fetchRef(scratchDir, options.gitlabUrl, branch, {
    localRef: `refs/heads/${branch}`,
    token: options.gitlabToken,
  });
  await checkoutBranch(scratchDir, branch);
  await fetchRef(scratchDir, options.gitlabUrl, gitlabDefaultBranch, {
    token: options.gitlabToken,
  });

  const result = await mergeRef(scratchDir, "FETCH_HEAD");

  if (result.kind === "conflict") {
    await abortMergeConflict(scratchDir);

    return { kind: "conflict", branch, conflictingFiles: result.conflictingFiles };
  }

  if (!options.dryRun) {
    await pushBranch(scratchDir, options.gitlabUrl, branch, options.gitlabToken);
  }

  return { kind: "merged", branch };
}

/**
 * Run one `gh-gl sync`: sync GitHub's default branch into GitLab's default
 * branch (rebuild path), or merge GitLab's default branch into a prototype
 * branch (merge path), depending on which branch is targeted.
 *
 * @param options - The sync inputs.
 * @returns What happened.
 */
export async function sync(
  options: Readonly<SyncOptions>,
): Promise<SyncOutcome> {
  const githubDefaultBranch = await detectDefaultBranch(
    options.githubUrl,
    options.githubToken,
  );
  const gitlabDefaultBranch = await detectDefaultBranch(
    options.gitlabUrl,
    options.gitlabToken,
  );

  if (githubDefaultBranch === undefined || gitlabDefaultBranch === undefined) {
    throw new Error(
      "Could not detect a default branch. The GitLab repo must have a commit on its default branch before the first sync.",
    );
  }

  const branch = options.branch ?? gitlabDefaultBranch;

  if (branch === gitlabDefaultBranch) {
    return runRebuild(options, branch, githubDefaultBranch);
  }

  const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

  try {
    await initScratchRepo(scratchDir);

    return await runMerge(scratchDir, options, branch, gitlabDefaultBranch);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
