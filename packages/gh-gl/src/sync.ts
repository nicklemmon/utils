import type { AskpassEnv } from "./askpass.js";
import type { SyncOutcome } from "./output.js";
import type { SyncAskpass } from "./resources.js";

import {
  abortMergeConflict,
  checkoutBranch,
  commitStagedChanges,
  commitEmpty,
  detectDefaultBranch,
  extractTree,
  fetchRef,
  mergeRef,
  pushBranch,
  readCommitMessage,
  resolveRef,
  setSymbolicHead,
} from "./git.js";
import { applyCapturedOverlay, captureOverlay } from "./overlay.js";
import { withScratchRepo, withSyncAskpass } from "./resources.js";
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
 * Bootstrap an empty GitLab repo's default branch by pushing an empty commit named after GitHub's.
 *
 * `detectDefaultBranch` cannot resolve a name when there are zero commits. Only GitLab gets this
 * treatment: GitHub is the source of truth, and an empty GitHub repo has nothing to sync.
 *
 * @param options - Sync inputs; uses `gitlabUrl` as the bootstrap push target.
 * @param githubDefaultBranch - Name taken from GitHub and used for the new GitLab default branch.
 * @param gitlabAskpassEnv - Live `GIT_ASKPASS` env for GitLab, or `undefined` for SSH.
 * @returns GitLab's now-resolvable default branch name. Usually `githubDefaultBranch`; a concurrent
 *   bootstrap may have created a different one first.
 */
async function bootstrapGitlabDefaultBranch(
  options: Readonly<SyncOptions>,
  githubDefaultBranch: string,
  gitlabAskpassEnv: AskpassEnv | undefined,
): Promise<string> {
  const outcome = await withScratchRepo(async (scratch): Promise<string> => {
    await setSymbolicHead(scratch.dir, `refs/heads/${githubDefaultBranch}`);
    await commitEmpty(scratch.dir, "Bootstrap commit created by gh-gl");

    const pushed = await pushBranch(
      scratch.dir,
      options.gitlabUrl,
      githubDefaultBranch,
      gitlabAskpassEnv,
    );

    if (pushed) {
      return githubDefaultBranch;
    }

    // A concurrent bootstrap (another sync run, or someone pushing by hand) won the race. That's
    // fine — re-detect and proceed with whatever is actually there now, rather than treating a
    // benign race as a hard failure.
    const redetected = await detectDefaultBranch(options.gitlabUrl, gitlabAskpassEnv);

    if (redetected === undefined) {
      throw new Error(
        `Could not bootstrap the GitLab repo's default branch: pushing an initial commit to "${githubDefaultBranch}" was rejected, and the repo still has no resolvable default branch.`,
      );
    }

    return redetected;
  });
  return outcome;
}

/** Preview the first rebuild when GitLab has no default branch yet. */
async function previewInitialRebuild(
  options: Readonly<SyncOptions>,
  githubDefaultBranch: string,
  askpass: SyncAskpass,
): Promise<SyncOutcome> {
  const outcome = await withScratchRepo(async (scratch): Promise<SyncOutcome> => {
    await fetchRef(scratch.dir, options.githubUrl, githubDefaultBranch, {
      shallow: true,
      askpassEnv: askpass.github,
    });

    const githubSha = await resolveRef(scratch.dir, "FETCH_HEAD");
    const overlay = await captureOverlay(scratch.dir, options.overlayDir);

    return {
      kind: "rebuilt",
      branch: githubDefaultBranch,
      githubSha,
      overlayFingerprint: overlay.fingerprint,
      dryRun: true,
    };
  });
  return outcome;
}

type RebuildAttempt = SyncOutcome | { kind: "push-rejected" };

/** Try one rebuild and report if the push was rejected. */
async function attemptRebuild(
  options: Readonly<SyncOptions>,
  branch: string,
  githubDefaultBranch: string,
  askpass: SyncAskpass,
): Promise<RebuildAttempt> {
  const outcome = await withScratchRepo(async (scratch): Promise<RebuildAttempt> => {
    const scratchDir = scratch.dir;
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
    const overlay = await captureOverlay(scratchDir, options.overlayDir);

    if (
      previousTrailers !== undefined &&
      previousTrailers.githubSha === githubSha &&
      previousTrailers.overlayFingerprint === overlay.fingerprint
    ) {
      return { kind: "no-op", branch, githubSha, overlayFingerprint: overlay.fingerprint };
    }

    if (options.dryRun) {
      return {
        kind: "rebuilt",
        branch,
        githubSha,
        overlayFingerprint: overlay.fingerprint,
        dryRun: true,
      };
    }

    await setSymbolicHead(scratchDir, `refs/heads/${branch}`);
    await extractTree(scratchDir, "FETCH_HEAD", scratchDir);
    await applyCapturedOverlay(scratchDir, overlay, githubSha);

    const trailers = formatSyncTrailers({ githubSha, overlayFingerprint: overlay.fingerprint });

    await commitStagedChanges(scratchDir, `Sync GitHub into GitLab\n\n${trailers}`);

    const pushed = await pushBranch(scratchDir, options.gitlabUrl, branch, askpass.gitlab);

    if (!pushed) {
      return { kind: "push-rejected" };
    }

    return {
      kind: "rebuilt",
      branch,
      githubSha,
      overlayFingerprint: overlay.fingerprint,
      dryRun: false,
    };
  });
  return outcome;
}

/**
 * Run the rebuild path for `branch`: wipe-and-rebuild it from GitHub's default branch plus overlay.
 *
 * Retries once from scratch if the push is rejected as non-fast-forward. A second rejection is a
 * real error, not another race to keep retrying.
 *
 * @param options - Sync inputs for this run.
 * @param branch - GitLab default branch being rebuilt.
 * @param githubDefaultBranch - GitHub default branch whose tree is the rebuild source.
 * @param askpass - Live `GIT_ASKPASS` env for each remote.
 * @returns Sync outcome for this rebuild attempt (including after one retry).
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
 * Run the merge path for `target.branch`: merge GitLab's default branch into it.
 *
 * Unlike {@link runRebuild}, this never retries a rejected push. A rebuild recomputes the same
 * target content on retry; a merge depends on `target.branch` at fetch time, so a retry after a
 * race could report a different result than the one already computed. A rejected push here is
 * always a real error for a human to resolve.
 *
 * @param scratchDir - Scratch repo owned by the current operation.
 * @param options - Sync inputs for this run.
 * @param target - Prototype branch, GitLab default branch to merge in, and GitLab askpass env.
 * @returns Sync outcome for this merge (`merged`, `conflict`, or a thrown error on push rejection).
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

type DefaultBranchLookup = (
  remoteUrl: string,
  askpassEnv: AskpassEnv | undefined,
) => Promise<string | undefined>;

/**
 * Detect both remote branches before sync uses either result.
 *
 * Waiting for both lookups keeps both credential helpers alive if one lookup fails while the other
 * still needs its helper.
 *
 * @param githubUrl - GitHub remote URL.
 * @param gitlabUrl - GitLab remote URL.
 * @param askpass - Live credential environments for both remotes.
 * @param lookup - Branch lookup operation. The default uses Git's remote HEAD lookup.
 * @returns The GitHub and GitLab default branch names.
 */
export async function detectRemoteDefaultBranches(
  githubUrl: string,
  gitlabUrl: string,
  askpass: SyncAskpass,
  lookup: DefaultBranchLookup = detectDefaultBranch,
): Promise<Readonly<{ github: string | undefined; gitlab: string | undefined }>> {
  const [githubBranch, gitlabBranch] = await Promise.allSettled([
    lookup(githubUrl, askpass.github),
    lookup(gitlabUrl, askpass.gitlab),
  ]);

  if (githubBranch.status === "rejected") throw githubBranch.reason;
  if (gitlabBranch.status === "rejected") throw gitlabBranch.reason;

  return { github: githubBranch.value, gitlab: gitlabBranch.value };
}

/**
 * Run one `gh-gl sync`.
 *
 * Rebuilds GitLab's default branch from GitHub plus overlay, or merges that default branch into a
 * prototype branch, depending on which branch is targeted.
 *
 * @param options - Remotes, overlay, target branch, dry-run flag, and optional HTTPS tokens.
 * @returns Sync outcome describing no-op, rebuild, merge, or conflict.
 */
export async function sync(options: Readonly<SyncOptions>): Promise<SyncOutcome> {
  const outcome = await withSyncAskpass(options, async (askpass): Promise<SyncOutcome> => {
    const { github: githubDefaultBranch, gitlab: gitlabDefaultBranch } =
      await detectRemoteDefaultBranches(options.githubUrl, options.gitlabUrl, askpass);

    if (githubDefaultBranch === undefined) {
      throw new Error(
        "Could not detect a default branch. The GitHub repo must have a commit on its default branch.",
      );
    }

    if (gitlabDefaultBranch === undefined) {
      if (options.branch !== undefined && options.branch !== githubDefaultBranch) {
        throw new Error(
          `Cannot sync prototype branch "${options.branch}" because the GitLab repo has no default branch. Create the default branch and the prototype branch before syncing it.`,
        );
      }

      if (options.dryRun) {
        return previewInitialRebuild(options, githubDefaultBranch, askpass);
      }
    }

    const resolvedGitlabDefaultBranch =
      gitlabDefaultBranch ??
      (await bootstrapGitlabDefaultBranch(options, githubDefaultBranch, askpass.gitlab));

    const branch = options.branch ?? resolvedGitlabDefaultBranch;

    if (branch === resolvedGitlabDefaultBranch) {
      return runRebuild(options, branch, githubDefaultBranch, askpass);
    }

    return withScratchRepo(async (scratch): Promise<SyncOutcome> => {
      const merged = await runMerge(scratch.dir, options, {
        branch,
        gitlabDefaultBranch: resolvedGitlabDefaultBranch,
        gitlabAskpassEnv: askpass.gitlab,
      });
      return merged;
    });
  });
  return outcome;
}
