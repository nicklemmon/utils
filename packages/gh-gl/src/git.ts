import { execa } from "execa";
import path from "node:path";
import { z } from "zod";

import type { AskpassEnv } from "./askpass.js";

/**
 * Build the execa options for a git call against a remote, merging in an already-created
 * `GIT_ASKPASS` helper's env (for an HTTPS remote) and any `extraEnv`, when either is given.
 *
 * @param askpassEnv - The env vars from a live `GIT_ASKPASS` helper (see {@link createAskpass}), or
 *   `undefined` for an SSH remote (or an HTTPS remote with no token, which will simply fail auth as
 *   git normally would). Callers create and clean up this helper once per token per sync run, not
 *   per git call — see `sync.ts`.
 * @param extraEnv - Additional env vars to set on the git subprocess, regardless of `askpassEnv`.
 * @returns The `env` option to pass to `execa`, or `{}` when there's nothing to add.
 */
function gitEnvOptions(
  askpassEnv: AskpassEnv | undefined,
  extraEnv?: Readonly<Record<string, string>>,
): Readonly<{ env?: Readonly<Record<string, string>> }> {
  return askpassEnv === undefined && extraEnv === undefined
    ? {}
    : { env: Object.assign({}, extraEnv, askpassEnv) };
}

/**
 * Detect the branch a remote's `HEAD` points at, the same mechanism GitHub and GitLab use to
 * implement their own "default branch" setting.
 *
 * @param remoteUrl - A full git remote URL (or local path, for tests).
 * @param askpassEnv - The env vars from a live `GIT_ASKPASS` helper authenticating `remoteUrl`, or
 *   `undefined` for an SSH remote.
 * @returns The branch name, or `undefined` if `HEAD` doesn't resolve (e.g. an empty repository with
 *   no commits).
 */
export async function detectDefaultBranch(
  remoteUrl: string,
  askpassEnv?: AskpassEnv,
): Promise<string | undefined> {
  const { stdout } = await execa(
    "git",
    ["ls-remote", "--symref", "--end-of-options", remoteUrl, "HEAD"],
    gitEnvOptions(askpassEnv),
  );
  const match = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(stdout);

  return match === null ? undefined : match[1];
}

/**
 * Initialize an empty git repository at `dir`, for use as a scratch working directory during a sync
 * run.
 *
 * @param dir - An existing empty directory.
 */
export async function initScratchRepo(dir: string): Promise<void> {
  // A fixed, unlikely-to-collide initial branch name: git refuses to fetch
  // into whichever branch is currently checked out, and the branch actually
  // being synced (main, or anything else) is not known until later.
  await execa("git", ["init", "--initial-branch=gh-gl-scratch-init", dir]);
  await execa("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  await execa("git", ["-C", dir, "config", "user.name", "gh-gl"]);
  await execa("git", ["-C", dir, "config", "user.email", "gh-gl@localhost"]);
}

/**
 * Fetch `ref` from `remoteUrl` into the scratch repo at `dir`. The fetched commit becomes reachable
 * as `FETCH_HEAD` in that repo.
 *
 * @param dir - A scratch repo previously created with {@link initScratchRepo}.
 * @param remoteUrl - A full git remote URL (or local path, for tests).
 * @param ref - The branch or ref to fetch.
 * @param options - `localRef` lands the fetched commit at that local ref (e.g. `refs/heads/main`)
 *   instead of the default `FETCH_HEAD`. Use this when fetching from two different remotes into the
 *   same scratch repo, so the second fetch doesn't overwrite the first's `FETCH_HEAD`. `shallow`
 *   fetches only `ref`'s tip commit (no history) — safe for the rebuild path, which only reads tree
 *   content, but wrong for the merge path: two independently shallow-fetched branches look like
 *   unrelated histories to git, and `git merge` refuses them outright. Defaults to a full fetch.
 *   `askpassEnv` is the env vars from a live `GIT_ASKPASS` helper authenticating `remoteUrl`, or
 *   `undefined` for an SSH remote.
 */
export async function fetchRef(
  dir: string,
  remoteUrl: string,
  ref: string,
  options?: Readonly<{
    localRef?: string;
    shallow?: boolean;
    askpassEnv?: AskpassEnv | undefined;
  }>,
): Promise<void> {
  const localRef = options === undefined ? undefined : options.localRef;
  const shallow = options === undefined ? false : options.shallow === true;
  const refspec = localRef === undefined ? ref : `${ref}:${localRef}`;
  const depthArgs = shallow ? ["--depth=1"] : [];

  await execa(
    "git",
    ["-C", dir, "fetch", ...depthArgs, "--end-of-options", remoteUrl, refspec],
    gitEnvOptions(options === undefined ? undefined : options.askpassEnv),
  );
}

/**
 * Point the scratch repo's `HEAD` at `ref`, without checking out any files. Used before committing,
 * so the new commit's parent is `ref`'s current value while the worktree and index stay exactly
 * what the caller placed there (an extracted tree plus an overlay, not `ref`'s old content).
 *
 * @param dir - A scratch repo previously created with {@link initScratchRepo}.
 * @param ref - The ref `HEAD` should point at, e.g. `refs/heads/main`.
 */
export async function setSymbolicHead(dir: string, ref: string): Promise<void> {
  await execa("git", ["-C", dir, "symbolic-ref", "HEAD", ref]);
}

/**
 * Read the full commit message at `ref` in the scratch repo at `dir`.
 *
 * @param dir - A scratch repo containing `ref`.
 * @param ref - A commit-ish, e.g. `FETCH_HEAD` or a branch name.
 * @returns The commit message, including its trailing newline.
 */
export async function readCommitMessage(dir: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["-C", dir, "log", "-1", "--format=%B", ref]);

  return `${stdout.replace(/\n+$/u, "")}\n`;
}

/**
 * Resolve `ref` to a commit sha in the scratch repo at `dir`.
 *
 * @param dir - A scratch repo containing `ref`.
 * @param ref - A commit-ish, e.g. `FETCH_HEAD` or a branch name.
 * @returns The full commit sha.
 */
export async function resolveRef(dir: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["-C", dir, "rev-parse", ref]);

  return stdout;
}

/**
 * Stage every change in the scratch repo's worktree and commit it.
 *
 * @param dir - A scratch repo previously created with {@link initScratchRepo}.
 * @param message - The commit message.
 */
export async function commitAll(dir: string, message: string): Promise<void> {
  await execa("git", ["-C", dir, "add", "--all"]);
  await execa("git", ["-C", dir, "commit", "-m", message]);
}

const ExecaFailureSchema = z.object({ stderr: z.string() });
const REJECTED_PUSH_PATTERN =
  /\[rejected\]|\[remote rejected\]|\(fetch first\)|\(non-fast-forward\)|\(failed to update ref\)|Up-to-date check failed/u;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function is the I/O boundary parser for a caught execa rejection.
function isRejectedPush(error: unknown): boolean {
  const parsed = ExecaFailureSchema.safeParse(error);

  return parsed.success && REJECTED_PUSH_PATTERN.test(parsed.data.stderr);
}

/**
 * Push the scratch repo's local `branch` to `remoteUrl`.
 *
 * @param dir - A scratch repo previously created with {@link initScratchRepo}.
 * @param remoteUrl - A full git remote URL (or local path, for tests).
 * @param branch - The branch name, same on both the local repo and the remote.
 * @param askpassEnv - The env vars from a live `GIT_ASKPASS` helper authenticating `remoteUrl`, or
 *   `undefined` for an SSH remote.
 * @returns `true` on a successful push, `false` when the remote rejected it as non-fast-forward
 *   (e.g. a concurrent sync run won the race). Any other failure is thrown.
 */
export async function pushBranch(
  dir: string,
  remoteUrl: string,
  branch: string,
  askpassEnv?: AskpassEnv,
): Promise<boolean> {
  try {
    await execa(
      "git",
      ["-C", dir, "push", "--end-of-options", remoteUrl, `${branch}:${branch}`],
      // Force English output so isRejectedPush's stderr matching doesn't depend on the caller's
      // locale (git translates its messages under LANG/LC_ALL).
      gitEnvOptions(askpassEnv, { LC_ALL: "C" }),
    );

    return true;
  } catch (error) {
    if (isRejectedPush(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Check out `branch` into the scratch repo's worktree. Unlike {@link setSymbolicHead}, this
 * populates the worktree and index with `branch`'s actual content — required before
 * {@link mergeRef}, which needs a real checkout to compute and apply a merge.
 *
 * @param dir - A scratch repo containing a local `branch` ref.
 * @param branch - The branch to check out.
 */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  await execa("git", ["-C", dir, "checkout", "--end-of-options", branch]);
}

/** The result of attempting a merge: clean, or blocked on real conflicts. */
export type MergeResult =
  | { kind: "clean" }
  | { kind: "conflict"; conflictingFiles: ReadonlyArray<string> };

async function listConflictingFiles(dir: string): Promise<Array<string>> {
  const { stdout } = await execa("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"]);

  return stdout === "" ? [] : stdout.split("\n");
}

/**
 * Attempt to merge `ref` into the branch currently checked out in the scratch repo at `dir`. Never
 * resolves conflicts automatically: on a conflict, the merge is left in progress so the caller can
 * inspect it, or abort it with {@link abortMergeConflict}.
 *
 * @param dir - A scratch repo with a branch checked out.
 * @param ref - The commit-ish to merge in, e.g. `FETCH_HEAD`.
 * @returns `{ kind: "clean" }`, or the list of conflicting file paths.
 */
export async function mergeRef(dir: string, ref: string): Promise<MergeResult> {
  try {
    await execa("git", ["-C", dir, "merge", "--no-edit", "--no-ff", ref]);

    return { kind: "clean" };
  } catch (error) {
    const conflictingFiles = await listConflictingFiles(dir);

    if (conflictingFiles.length === 0) {
      throw error;
    }

    return { kind: "conflict", conflictingFiles };
  }
}

/**
 * Abort an in-progress conflicted merge, leaving the branch exactly as it was before
 * {@link mergeRef} was called.
 *
 * @param dir - A scratch repo with a conflicted merge in progress.
 */
export async function abortMergeConflict(dir: string): Promise<void> {
  await execa("git", ["-C", dir, "merge", "--abort"]);
}

/**
 * Extract the tree at `ref` into `destDir`, via `git archive | tar -x`. This preserves file modes
 * and symlinks, unlike a plain filesystem copy.
 *
 * @param dir - A scratch repo containing `ref`.
 * @param ref - A commit-ish, e.g. `FETCH_HEAD` or a branch name.
 * @param destDir - An existing directory to extract into.
 */
export async function extractTree(dir: string, ref: string, destDir: string): Promise<void> {
  const archive = execa("git", ["-C", dir, "archive", ref], {
    encoding: "buffer",
  });
  const extract = execa("tar", ["-x", "-C", destDir]);

  if (archive.stdout === null) {
    throw new Error("git archive produced no stdout stream");
  }

  archive.stdout.pipe(extract.stdin);
  await Promise.all([archive, extract]);
}

/**
 * Fingerprint the current content of `sourceDir` as a git tree hash, without assuming `sourceDir`
 * is itself a git checkout. Stages `sourceDir` into a throwaway index backed by the scratch repo at
 * `dir`, so this works for any directory on disk (a git checkout, an extracted archive, anything).
 *
 * @param dir - A scratch repo previously created with {@link initScratchRepo}.
 * @param sourceDir - The directory to fingerprint.
 * @returns The tree hash for `sourceDir`'s current content.
 */
export async function fingerprintDirectory(dir: string, sourceDir: string): Promise<string> {
  const env = {
    GIT_DIR: path.join(dir, ".git"),
    GIT_WORK_TREE: sourceDir,
    GIT_INDEX_FILE: path.join(dir, ".git", "gh-gl-fingerprint-index"),
  };

  await execa("git", ["add", "--all", "."], { cwd: sourceDir, env });

  const { stdout } = await execa("git", ["write-tree"], {
    cwd: sourceDir,
    env,
  });

  return stdout;
}
