import { execa } from "execa";
import path from "node:path";
import { z } from "zod";

import type { AskpassEnv } from "./askpass.js";

/**
 * Build the execa `env` option for a git call against a remote.
 *
 * Merges a live `GIT_ASKPASS` helper (HTTPS) with any `extraEnv`. Callers create and clean up the
 * helper once per token per sync run, not per git call — see `sync.ts`.
 *
 * @param askpassEnv - Env from {@link createAskpass}, or `undefined` for SSH (or HTTPS with no
 *   token, which fails auth the way git normally would).
 * @param extraEnv - Extra env vars for the git subprocess, applied even when `askpassEnv` is
 *   absent.
 * @returns An object with `env` for execa, or `{}` when neither source contributes vars.
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
 * Detect the branch a remote's `HEAD` points at.
 *
 * Uses the same `ls-remote --symref` mechanism GitHub and GitLab use for their default-branch
 * setting.
 *
 * @param remoteUrl - Full git remote URL, or a local path in tests.
 * @param askpassEnv - Live `GIT_ASKPASS` env for `remoteUrl`, or `undefined` for SSH.
 * @returns The branch name, or `undefined` when `HEAD` does not resolve (empty repo, no commits).
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
 * Initialize an empty git repository at `dir` for use as a scratch working directory during sync.
 *
 * @param dir - Existing empty directory that becomes the scratch repo root.
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
 * Fetch `ref` from `remoteUrl` into the scratch repo at `dir`.
 *
 * The fetched commit becomes reachable as `FETCH_HEAD` unless `options.localRef` says otherwise.
 *
 * @param dir - Scratch repo from {@link initScratchRepo}.
 * @param remoteUrl - Full git remote URL, or a local path in tests.
 * @param ref - Branch or ref to fetch.
 * @param options - `localRef` stores the tip at that local ref so a second fetch into the same
 *   scratch repo does not overwrite `FETCH_HEAD`. `shallow` fetches only the tip (safe for rebuild
 *   tree reads; wrong for merge, where two shallow tips look unrelated). Defaults to a full fetch.
 *   `askpassEnv` authenticates HTTPS remotes; omit it for SSH.
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
 * Point the scratch repo's `HEAD` at `ref` without checking out any files.
 *
 * Used before committing so the new commit's parent is `ref` while the worktree stays whatever the
 * caller placed there (extracted tree plus overlay), not `ref`'s old content.
 *
 * @param dir - Scratch repo from {@link initScratchRepo}.
 * @param ref - Ref `HEAD` should point at, such as `refs/heads/main`.
 */
export async function setSymbolicHead(dir: string, ref: string): Promise<void> {
  await execa("git", ["-C", dir, "symbolic-ref", "HEAD", ref]);
}

/**
 * Read the full commit message at `ref` in the scratch repo at `dir`.
 *
 * @param dir - Scratch repo that contains `ref`.
 * @param ref - Commit-ish such as `FETCH_HEAD` or a branch name.
 * @returns Commit message body, always ending with a trailing newline.
 */
export async function readCommitMessage(dir: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["-C", dir, "log", "-1", "--format=%B", ref]);

  return `${stdout.replace(/\n+$/u, "")}\n`;
}

/**
 * Resolve `ref` to a commit sha in the scratch repo at `dir`.
 *
 * @param dir - Scratch repo that contains `ref`.
 * @param ref - Commit-ish such as `FETCH_HEAD` or a branch name.
 * @returns Full 40-character commit sha.
 */
export async function resolveRef(dir: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["-C", dir, "rev-parse", ref]);

  return stdout;
}

/**
 * Stage every change in the scratch repo's worktree and commit it.
 *
 * @param dir - Scratch repo from {@link initScratchRepo}.
 * @param message - Commit message body passed to `git commit -m`.
 */
export async function commitAll(dir: string, message: string): Promise<void> {
  await execa("git", ["-C", dir, "add", "--all"]);
  await execa("git", ["-C", dir, "commit", "-m", message]);
}

/**
 * Create an empty commit (no file changes) in the scratch repo at `dir`.
 *
 * Used to bootstrap a branch that does not exist yet, such as an empty GitLab default branch. Pair
 * with {@link setSymbolicHead} first.
 *
 * @param dir - Scratch repo from {@link initScratchRepo}.
 * @param message - Commit message body passed to `git commit --allow-empty -m`.
 */
export async function commitEmpty(dir: string, message: string): Promise<void> {
  await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", message]);
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
 * @param dir - Scratch repo from {@link initScratchRepo}.
 * @param remoteUrl - Full git remote URL, or a local path in tests.
 * @param branch - Branch name on both the local repo and the remote.
 * @param askpassEnv - Live `GIT_ASKPASS` env for `remoteUrl`, or `undefined` for SSH.
 * @returns `true` when the push succeeds; `false` when the remote rejects it as non-fast-forward
 *   (for example a concurrent sync won the race). Any other failure is thrown.
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
 * Check out `branch` into the scratch repo's worktree.
 *
 * Unlike {@link setSymbolicHead}, this populates the worktree and index with `branch`'s content.
 * Required before {@link mergeRef}, which needs a real checkout to compute the merge.
 *
 * @param dir - Scratch repo that already has a local `branch` ref.
 * @param branch - Local branch name to check out.
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
 * Attempt to merge `ref` into the branch currently checked out in the scratch repo at `dir`.
 *
 * Never resolves conflicts automatically. On a conflict, the merge stays in progress so the caller
 * can inspect it or abort with {@link abortMergeConflict}.
 *
 * @param dir - Scratch repo with a branch already checked out.
 * @param ref - Commit-ish to merge in, such as `FETCH_HEAD`.
 * @returns A clean merge result, or the conflicting file paths when the merge stops on conflicts.
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
 * Abort an in-progress conflicted merge.
 *
 * Leaves the branch exactly as it was before {@link mergeRef} ran.
 *
 * @param dir - Scratch repo that currently has a conflicted merge in progress.
 */
export async function abortMergeConflict(dir: string): Promise<void> {
  await execa("git", ["-C", dir, "merge", "--abort"]);
}

/**
 * Extract the tree at `ref` into `destDir` via `git archive | tar -x`.
 *
 * Preserves file modes and symlinks, unlike a plain filesystem copy.
 *
 * @param dir - Scratch repo that contains `ref`.
 * @param ref - Commit-ish such as `FETCH_HEAD` or a branch name.
 * @param destDir - Existing directory that receives the extracted tree.
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
 * Fingerprint the current content of `sourceDir` as a git tree hash.
 *
 * Does not require `sourceDir` to be a git checkout. Stages it into a throwaway index backed by the
 * scratch repo at `dir`, so any directory on disk works.
 *
 * @param dir - Scratch repo from {@link initScratchRepo}, used only for its object store and index.
 * @param sourceDir - Directory whose current tree content should be hashed.
 * @returns Git tree hash for `sourceDir`'s current content.
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
