import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A live `GIT_ASKPASS` helper: env vars to set, and a cleanup to remove it. */
export type Askpass = {
  env: Readonly<{ GIT_ASKPASS: string; GIT_ASKPASS_TOKEN: string }>;
  cleanup: () => void;
};

/**
 * Create a temporary `GIT_ASKPASS` helper script that echoes `token` back to
 * git, for authenticating a single HTTPS remote. The token is passed to the
 * script via a scoped env var, not embedded in the script itself, so it never
 * appears in a URL, argv, or any git config file.
 *
 * @param token - The credential to hand back to git when it prompts.
 * @returns The env vars to set on the git subprocess, and a `cleanup` to
 *   remove the script once that subprocess has finished.
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
