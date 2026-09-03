import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AskpassEnv } from "./askpass.js";
import type { SyncOutcome } from "./output.js";

import { createAskpass } from "./askpass.js";
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

/**
 * The live `GIT_ASKPASS` env for each remote in a sync run, created once per token per run (not
 * once per git call) — see {@link sync}.
 */
type SyncAskpass = Readonly<{ github: AskpassEnv | undefined; gitlab: AskpassEnv | undefined }>;

/** A scratch repo's directory, and a `cleanup` to remove it once the caller is done with it. */
type ScratchRepo = Readonly<{ dir: string; cleanup: () => void }>;

/**
 * Create a fresh scratch repo, initialized with {@link initScratchRepo}, for a sync run to use as
 * its working directory.
 *
 * @returns The scratch repo's directory, and a `cleanup` to remove it.
 */
async function createScratchRepo(): Promise<ScratchRepo> {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

  await initScratchRepo(dir);

  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type RebuildAttempt = SyncOutcome | { kind: "push-rejected" };

async function attemptRebuild(
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
  askpass: SyncAskpass,
): Promise<RebuildAttempt> {
  const scratch = await createScratchRepo();
  const scratchDir = scratch.dir;

  try {
    await fetchRef(scratchDir, options.gitlabUrl, branch, {
      localRef: `refs/heads/${branch}`,
      askpassEnv: askpass.gitlab,
    });

    const previousMessage = await readCommitMessage(scratchDir, `refs/heads/${branch}`);
    const previousTrailers = parseSyncTrailers(previousMessage);

    await fetchRef(scratchDir, options.githubUrl, githubDefaultBranch, {
      shallow: true,
      askpassEnv: askpass.github,
    });

    const githubSha = await resolveRef(scratchDir, "FETCH_HEAD");
    const overlayFingerprint = await fingerprintDirectory(scratchDir, options.overlayDir);

    if (
      previousTrailers !== undefined &&
      previousTrailers.githubSha === githubSha &&
      previousTrailers.overlayFingerprint === overlayFingerprint
    ) {
      return { kind: "no-op", branch, githubSha, overlayFingerprint };
    }

    if (options.dryRun) {
      return {
        kind: "rebuilt",
        branch,
        githubSha,
        overlayFingerprint,
        dryRun: true,
      };
    }

    await setSymbolicHead(scratchDir, `refs/heads/${branch}`);
    await extractTree(scratchDir, "FETCH_HEAD", scratchDir);
    await copyOverlayOnto(options.overlayDir, scratchDir);

    const trailers = formatSyncTrailers({ githubSha, overlayFingerprint });

    await commitAll(scratchDir, `Sync GitHub into GitLab\n\n${trailers}`);

    const pushed = await pushBranch(scratchDir, options.gitlabUrl, branch, askpass.gitlab);

    if (!pushed) {
      return { kind: "push-rejected" };
    }

    return {
      kind: "rebuilt",
      branch,
      githubSha,
      overlayFingerprint,
      dryRun: false,
    };
  } finally {
    scratch.cleanup();
  }
}

/**
 * Run the rebuild path for `branch`: wipe-and-rebuild it from GitHub's default branch plus the
 * overlay. Retries once, from scratch, if the push is rejected as non-fast-forward (e.g. a
 * concurrent sync run won the race); a second rejection is a real error, not a race to keep
 * retrying.
 *
 * @param options - The sync inputs.
 * @param branch - The GitLab branch being rebuilt (its own default branch).
 * @param githubDefaultBranch - GitHub's default branch name.
 * @param askpass - The live `GIT_ASKPASS` env for each remote.
 * @returns What happened.
 */
async function runRebuild(
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
  askpass: SyncAskpass,
): Promise<SyncOutcome> {
  const first = await attemptRebuild(options, branch, githubDefaultBranch, askpass);

  if (first.kind !== "push-rejected") {
    return first;
  }

  const retry = await attemptRebuild(options, branch, githubDefaultBranch, askpass);

  if (retry.kind === "push-rejected") {
    throw new Error(
      `Push to ${branch} was rejected twice in a row; another sync run may be in progress.`,
    );
  }

  return retry;
}

/** The GitLab branch a {@link runMerge} call is merging GitLab's default branch into. */
type MergeTarget = Readonly<{
  branch: string;
  gitlabDefaultBranch: string;
  gitlabAskpassEnv: AskpassEnv | undefined;
}>;

/**
 * Run the merge path for `target.branch`: merge GitLab's default branch into it. Unlike
 * {@link runRebuild}, this never retries a rejected push — a rebuild recomputes the same target
 * content from scratch on retry, but a merge's result depends on `target.branch`'s content at fetch
 * time, so retrying after a race would need a fresh fetch and merge, which risks a different (or
 * newly conflicting) result than the one already reported to the caller. A rejected push here is
 * always a real error for a human to resolve.
 *
 * @param scratchDir - A scratch repo previously created with {@link initScratchRepo}.
 * @param options - The sync inputs.
 * @param target - The branch being merged into, GitLab's default branch being merged in, and the
 *   live `GIT_ASKPASS` env for the GitLab remote.
 * @returns What happened.
 */
async function runMerge(
  scratchDir: string,
  options: Readonly<SyncOptions>,
  target: MergeTarget,
): Promise<SyncOutcome> {
  const { branch, gitlabDefaultBranch, gitlabAskpassEnv } = target;

  await fetchRef(scratchDir, options.gitlabUrl, branch, {
    localRef: `refs/heads/${branch}`,
    askpassEnv: gitlabAskpassEnv,
  });
  await checkoutBranch(scratchDir, branch);
  await fetchRef(scratchDir, options.gitlabUrl, gitlabDefaultBranch, {
    askpassEnv: gitlabAskpassEnv,
  });

  const result = await mergeRef(scratchDir, "FETCH_HEAD");

  if (result.kind === "conflict") {
    await abortMergeConflict(scratchDir);

    return {
      kind: "conflict",
      branch,
      conflictingFiles: result.conflictingFiles,
      gitlabUrl: options.gitlabUrl,
      gitlabDefaultBranch,
    };
  }

  if (options.dryRun) {
    return { kind: "merged", branch, dryRun: true };
  }

  const pushed = await pushBranch(scratchDir, options.gitlabUrl, branch, gitlabAskpassEnv);

  if (!pushed) {
    throw new Error(
      `Push to ${branch} was rejected — the remote moved during this run (e.g. someone else pushed to it). Fetch and merge locally to resolve, then re-run.`,
    );
  }

  return { kind: "merged", branch, dryRun: false };
}

/**
 * Run one `gh-gl sync`: sync GitHub's default branch into GitLab's default branch (rebuild path),
 * or merge GitLab's default branch into a prototype branch (merge path), depending on which branch
 * is targeted.
 *
 * @param options - The sync inputs.
 * @returns What happened.
 */
export async function sync(options: Readonly<SyncOptions>): Promise<SyncOutcome> {
  const githubAskpass =
    options.githubToken === undefined ? undefined : createAskpass(options.githubToken);
  const gitlabAskpass =
    options.gitlabToken === undefined ? undefined : createAskpass(options.gitlabToken);
  const askpass: SyncAskpass = {
    github: githubAskpass === undefined ? undefined : githubAskpass.env,
    gitlab: gitlabAskpass === undefined ? undefined : gitlabAskpass.env,
  };

  try {
    const [githubDefaultBranch, gitlabDefaultBranch] = await Promise.all([
      detectDefaultBranch(options.githubUrl, askpass.github),
      detectDefaultBranch(options.gitlabUrl, askpass.gitlab),
    ]);

    if (githubDefaultBranch === undefined || gitlabDefaultBranch === undefined) {
      throw new Error(
        "Could not detect a default branch. The GitLab repo must have a commit on its default branch before the first sync.",
      );
    }

    const branch = options.branch ?? gitlabDefaultBranch;

    if (branch === gitlabDefaultBranch) {
      return await runRebuild(options, branch, githubDefaultBranch, askpass);
    }

    const scratch = await createScratchRepo();

    try {
      return await runMerge(scratch.dir, options, {
        branch,
        gitlabDefaultBranch,
        gitlabAskpassEnv: askpass.gitlab,
      });
    } finally {
      scratch.cleanup();
    }
  } finally {
    if (githubAskpass !== undefined) {
      githubAskpass.cleanup();
    }

    if (gitlabAskpass !== undefined) {
      gitlabAskpass.cleanup();
    }
  }
}
