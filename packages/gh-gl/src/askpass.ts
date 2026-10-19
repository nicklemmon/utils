import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The env vars a live `GIT_ASKPASS` helper needs set on the git subprocess. */
export type AskpassEnv = Readonly<{ GIT_ASKPASS: string; GIT_ASKPASS_TOKEN: string }>;

/** A live `GIT_ASKPASS` helper: env vars to set, and a cleanup to remove it. */
export type Askpass = {
  env: AskpassEnv;
  cleanup: () => void;
};

type AskpassOperations = Readonly<{
  createDirectory: () => string;
  writeScript: (file: string, content: string) => void;
  makeExecutable: (file: string) => void;
  removeDirectory: (dir: string) => void;
}>;

const defaultOperations: AskpassOperations = {
  /** Create a temporary directory for the helper. */
  createDirectory: () => mkdtempSync(path.join(tmpdir(), "gh-gl-askpass-")),
  /** Write the helper script to disk. */
  writeScript: (file, content) => {
    writeFileSync(file, content);
  },
  /** Mark the helper script as executable. */
  makeExecutable: (file) => {
    chmodSync(file, 0o700);
  },
  /** Remove the temporary helper directory. */
  removeDirectory: (dir) => {
    rmSync(dir, { recursive: true, force: true });
  },
};

/**
 * Create an askpass helper with injected filesystem operations for focused tests.
 *
 * @param token - Credential the helper prints when git prompts for a password.
 * @param operations - Filesystem operations used to create and remove the helper.
 * @returns Env vars to set on the git subprocess, plus a cleanup function.
 */
export function createAskpassWithOperations(token: string, operations: AskpassOperations): Askpass {
  const dir = operations.createDirectory();
  const scriptPath = path.join(dir, "askpass.sh");

  try {
    operations.writeScript(scriptPath, '#!/bin/sh\necho "$GIT_ASKPASS_TOKEN"\n');
    operations.makeExecutable(scriptPath);
  } catch (workError) {
    try {
      operations.removeDirectory(dir);
    } catch (cleanupError) {
      throw new AggregateError(
        [workError, cleanupError],
        `Askpass setup failed: ${String(workError)}; askpass cleanup failed: ${String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    // oxlint-disable-next-line eslint(preserve-caught-error) -- Keep the original setup error.
    throw workError;
  }

  return {
    env: { GIT_ASKPASS: scriptPath, GIT_ASKPASS_TOKEN: token },
    /** Remove the temporary helper directory. */
    cleanup: () => {
      operations.removeDirectory(dir);
    },
  };
}

/**
 * Create a temporary `GIT_ASKPASS` helper that echoes `token` back to git for one HTTPS remote.
 *
 * The token is passed via a scoped env var, not embedded in the script, so it never appears in a
 * URL, argv, or git config.
 *
 * @param token - Credential the helper prints when git prompts for a password.
 * @returns Env vars to set on the git subprocess, plus a `cleanup` that deletes the helper script.
 */
export function createAskpass(token: string): Askpass {
  return createAskpassWithOperations(token, defaultOperations);
}
