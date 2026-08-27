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
  branch?: string;
  dryRun: boolean;
};

async function runRebuild(
  scratchDir: string,
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
): Promise<SyncOutcome> {
  await fetchRef(scratchDir, options.gitlabUrl, branch, {
    localRef: `refs/heads/${branch}`,
  });

  const previousMessage = await readCommitMessage(
    scratchDir,
    `refs/heads/${branch}`,
  );
  const previousTrailers = parseSyncTrailers(previousMessage);

  await fetchRef(scratchDir, options.githubUrl, githubDefaultBranch, {
    shallow: true,
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
  await pushBranch(scratchDir, options.gitlabUrl, branch);

  return { kind: "rebuilt", branch, githubSha, overlayFingerprint };
}

async function runMerge(
  scratchDir: string,
  options: Readonly<SyncOptions>,
  branch: string,
  gitlabDefaultBranch: string,
): Promise<SyncOutcome> {
  await fetchRef(scratchDir, options.gitlabUrl, branch, {
    localRef: `refs/heads/${branch}`,
  });
  await checkoutBranch(scratchDir, branch);
  await fetchRef(scratchDir, options.gitlabUrl, gitlabDefaultBranch);

  const result = await mergeRef(scratchDir, "FETCH_HEAD");

  if (result.kind === "conflict") {
    await abortMergeConflict(scratchDir);

    return { kind: "conflict", branch, conflictingFiles: result.conflictingFiles };
  }

  if (!options.dryRun) {
    await pushBranch(scratchDir, options.gitlabUrl, branch);
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
  const githubDefaultBranch = await detectDefaultBranch(options.githubUrl);
  const gitlabDefaultBranch = await detectDefaultBranch(options.gitlabUrl);

  if (githubDefaultBranch === undefined || gitlabDefaultBranch === undefined) {
    throw new Error(
      "Could not detect a default branch. The GitLab repo must have a commit on its default branch before the first sync.",
    );
  }

  const branch = options.branch ?? gitlabDefaultBranch;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

  try {
    await initScratchRepo(scratchDir);

    if (branch === gitlabDefaultBranch) {
      return await runRebuild(scratchDir, options, branch, githubDefaultBranch);
    }

    return await runMerge(scratchDir, options, branch, gitlabDefaultBranch);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
