import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Askpass, AskpassEnv } from "./askpass.js";

import { createAskpass } from "./askpass.js";
import { initScratchRepo } from "./git.js";

/** A scratch repository directory owned for one operation. */
type ScratchRepo = Readonly<{ dir: string }>;

type ScratchOperations = Readonly<{
  createDirectory: () => string;
  initialize: (dir: string) => Promise<void>;
  removeDirectory: (dir: string) => void;
}>;

const defaultScratchOperations: ScratchOperations = {
  createDirectory: () => mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-")),
  initialize: initScratchRepo,
  removeDirectory: (dir) => {
    rmSync(dir, { recursive: true, force: true });
  },
};

/**
 * Run an operation with a fresh initialized scratch repository.
 *
 * Cleanup always runs after allocation, including when initialization fails. A cleanup failure is
 * reported with the work error when both fail.
 *
 * @param operation - Work that uses the scratch repository.
 * @param operations - Internal filesystem seam for deterministic resource failure tests.
 * @returns The operation result.
 */
export async function withScratchRepo<Result>(
  operation: (scratch: ScratchRepo) => Promise<Result>,
  operations: ScratchOperations = defaultScratchOperations,
): Promise<Result> {
  const dir = operations.createDirectory();
  let outcome: { kind: "success"; value: Result } | { kind: "failure"; error: unknown };

  try {
    await operations.initialize(dir);
    outcome = { kind: "success", value: await operation({ dir }) };
  } catch (error) {
    outcome = { kind: "failure", error };
  }

  let cleanupError: unknown;
  let cleanupFailed = false;

  try {
    operations.removeDirectory(dir);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (outcome.kind === "failure" && cleanupFailed) {
    throw new AggregateError(
      [outcome.error, cleanupError],
      `Scratch operation failed: ${String(outcome.error)}; scratch cleanup failed: ${String(cleanupError)}`,
      { cause: outcome.error },
    );
  }

  if (outcome.kind === "failure") {
    throw outcome.error;
  }

  if (cleanupFailed) {
    throw cleanupError;
  }

  return outcome.value;
}

/** Live askpass environments for each remote in one sync run. */
export type SyncAskpass = Readonly<{
  github: AskpassEnv | undefined;
  gitlab: AskpassEnv | undefined;
}>;

type AskpassFactory = (token: string) => Askpass;

/**
 * Run an operation with helpers for the supplied GitHub and GitLab tokens.
 *
 * Each helper remains alive until the operation settles. Cleanup tries every created helper in
 * reverse order.
 *
 * @param tokens - Optional credentials for each remote.
 * @param operation - Work that uses the live environments.
 * @param createHelper - Internal helper factory for deterministic failure tests.
 * @returns The operation result.
 */
export async function withSyncAskpass<Result>(
  tokens: Readonly<{ githubToken?: string | undefined; gitlabToken?: string | undefined }>,
  operation: (askpass: SyncAskpass) => Promise<Result>,
  createHelper: AskpassFactory = createAskpass,
): Promise<Result> {
  const helpers: Askpass[] = [];
  let outcome: { kind: "success"; value: Result } | { kind: "failure"; error: unknown };

  try {
    let github: Askpass | undefined;
    let gitlab: Askpass | undefined;

    if (tokens.githubToken !== undefined) {
      github = createHelper(tokens.githubToken);
      helpers.push(github);
    }

    if (tokens.gitlabToken !== undefined) {
      gitlab = createHelper(tokens.gitlabToken);
      helpers.push(gitlab);
    }

    outcome = {
      kind: "success",
      value: await operation({
        github: github === undefined ? undefined : github.env,
        gitlab: gitlab === undefined ? undefined : gitlab.env,
      }),
    };
  } catch (error) {
    outcome = { kind: "failure", error };
  }

  const cleanupErrors: unknown[] = [];
  for (let index = helpers.length - 1; index >= 0; index -= 1) {
    const helper = helpers[index];

    if (helper === undefined) {
      continue;
    }

    try {
      helper.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (outcome.kind === "failure" && cleanupErrors.length > 0) {
    throw new AggregateError(
      [outcome.error, ...cleanupErrors],
      `Sync operation failed: ${String(outcome.error)}; helper cleanup failed: ${cleanupErrors.map(String).join("; ")}`,
      { cause: outcome.error },
    );
  }

  if (outcome.kind === "failure") {
    throw outcome.error;
  }

  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }

  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      `Helper cleanup failed: ${cleanupErrors.map(String).join("; ")}`,
    );
  }

  return outcome.value;
}
