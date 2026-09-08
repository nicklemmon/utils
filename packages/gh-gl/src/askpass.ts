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
  const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-askpass-"));
  const scriptPath = path.join(dir, "askpass.sh");

  writeFileSync(scriptPath, '#!/bin/sh\necho "$GIT_ASKPASS_TOKEN"\n');
  chmodSync(scriptPath, 0o700);

  return {
    env: { GIT_ASKPASS: scriptPath, GIT_ASKPASS_TOKEN: token },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
