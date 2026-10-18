import { execa } from "execa";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AskpassEnv } from "./askpass.js";

import { withSyncAskpass } from "./resources.js";
import { detectRemoteDefaultBranches } from "./sync.js";
import { createBareFixtureRepo, createFixtureRepo } from "./test-support/fixture-repo.js";

type Signal<Value> = Readonly<{ promise: Promise<Value>; resolve: (value: Value) => void }>;

/** Reject use of a signal before its promise resolver is assigned. */
function uninitializedSignal(): never {
  throw new Error("Signal is not initialized");
}

/** Create a promise signal with a resolver for deterministic ordering. */
function signal<Value>(): Signal<Value> {
  let complete: (value: Value) => void = uninitializedSignal;
  const promise = new Promise<Value>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    /** Resolve the signal promise. */
    resolve: (value) => {
      complete(value);
    },
  };
}

const askpassEnvSchema = z.object({
  GIT_ASKPASS: z.string().min(1),
  GIT_ASKPASS_TOKEN: z.string(),
});

describe("sync resource acceptance", () => {
  const packageDir = path.resolve(import.meta.dirname, "..");
  // The build must be inside the package so the bundle resolves its dependencies.
  let buildDir = "";
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    buildDir = mkdtempSync(path.join(packageDir, ".gh-gl-resource-test-"));
    await execa(
      "tsdown",
      [
        "src/sync.ts",
        "--no-config",
        "--out-dir",
        buildDir,
        "--platform",
        "node",
        "--format",
        "esm",
        "--logLevel",
        "error",
      ],
      { cwd: packageDir, preferLocal: true },
    );
  });

  afterAll(() => {
    if (buildDir !== "") rmSync(buildDir, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("keeps a real credential helper alive until pending work finishes", async () => {
    const entered = signal<string>();
    const release = signal<boolean>();
    const pending = withSyncAskpass({ githubToken: "lifetime-test-token" }, async (askpass) => {
      const env = askpassEnvSchema.parse(askpass.github);
      const helperPath = env.GIT_ASKPASS;
      entered.resolve(helperPath);
      await release.promise;
      const response = await execa(helperPath, ["Password:"], { env });
      return response.stdout;
    });
    const helperPath = await entered.promise;
    try {
      expect(existsSync(helperPath)).toBe(true);
    } finally {
      release.resolve(true);
    }
    expect(await pending).toBe("lifetime-test-token");
    expect(existsSync(helperPath)).toBe(false);
  });

  it("retains the held lookup helper after its sibling fails", async () => {
    type BranchLookup = (url: string, env: AskpassEnv | undefined) => Promise<string | undefined>;

    const gitlabEntered = signal<null>();
    const githubFailed = signal<null>();
    const releaseGitlab = signal<null>();
    let gitlabHelper = "";
    let gitlabToken: string | undefined;
    let operationError: unknown;
    let settled = false;
    /** Fail GitHub lookup after GitLab has entered its held lookup. */
    const failGithub: BranchLookup = async (): Promise<string | undefined> => {
      await gitlabEntered.promise;
      githubFailed.resolve(null);
      throw new Error("forced lookup failure");
    };
    /** Hold GitLab lookup until the test releases its helper. */
    const holdGitlab: BranchLookup = async (_url, env): Promise<string | undefined> => {
      const parsedEnv = askpassEnvSchema.parse(env);
      gitlabHelper = parsedEnv.GIT_ASKPASS;
      gitlabEntered.resolve(null);
      await releaseGitlab.promise;

      const response = await execa(parsedEnv.GIT_ASKPASS, ["Password:"], { env: parsedEnv });
      gitlabToken = response.stdout;
      return "main";
    };
    let lookupHandler = failGithub;
    /** Route concurrent lookups through the controlled handlers. */
    const lookup: BranchLookup = async (url, env): Promise<string | undefined> => {
      const handler = lookupHandler;
      lookupHandler = holdGitlab;
      const result = await handler(url, env);
      return result;
    };
    /** Capture the expected lookup failure and mark the operation settled. */
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse the async rejection at this error boundary.
    const captureFailure = (error: unknown): "failure" => {
      settled = true;
      operationError = z.instanceof(Error).parse(error);
      return "failure";
    };

    const pending = withSyncAskpass(
      { githubToken: "github-lifetime-token", gitlabToken: "gitlab-lifetime-token" },
      async (askpass) => {
        await detectRemoteDefaultBranches("fixture:github", "fixture:gitlab", askpass, lookup);
      },
    ).then(() => {
      settled = true;
      return "success";
    }, captureFailure);

    await githubFailed.promise;
    // Both lookups are controlled promises. This event-loop turn drains every rejection and
    // cleanup continuation from the failed lookup before the held GitLab lookup is released.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const beforeRelease = {
      settled,
      helperExists: existsSync(gitlabHelper),
    };

    releaseGitlab.resolve(null);
    expect(await pending).toBe("failure");

    expect(beforeRelease).toEqual({ settled: false, helperExists: true });
    expect(operationError).toEqual(new Error("forced lookup failure"));
    expect(gitlabToken).toBe("gitlab-lifetime-token");
    expect(existsSync(gitlabHelper)).toBe(false);
  });

  it("removes scratch and credential helpers when Git initialization fails", async () => {
    const github = await createFixtureRepo();
    cleanups.push(github.cleanup);
    await github.commit("Seed upstream", { "README.md": "upstream" });
    const gitlab = await createBareFixtureRepo({ "seed.txt": "seed" });
    cleanups.push(gitlab.cleanup);
    const root = mkdtempSync(path.join(tmpdir(), "resource-acceptance-"));
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const childTmp = path.join(root, "tmp");
    const bin = path.join(root, "bin");
    const overlayDir = path.join(root, "overlay");
    mkdirSync(childTmp);
    mkdirSync(bin);
    mkdirSync(overlayDir);
    writeFileSync(path.join(overlayDir, "config.txt"), "overlay");
    const realGit = await execa("which", ["git"]);
    const wrapper = path.join(bin, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "init" ]; then',
        '  echo "forced scratch init failure" >&2',
        "  exit 71",
        "fi",
        'exec "$ARCHITECTURE_REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    const options = {
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
      githubToken: "test-github-token",
      gitlabToken: "test-gitlab-token",
    };
    const script = [
      `import { sync } from ${JSON.stringify(path.join(buildDir, "sync.mjs"))};`,
      `try { await sync(${JSON.stringify(options)}); }`,
      "catch (error) { console.log(error.message); process.exitCode = 2; }",
    ].join("\n");
    const result = await execa(process.execPath, ["--input-type=module", "--eval", script], {
      reject: false,
      env: {
        TMPDIR: childTmp,
        PATH: `${bin}:${path.dirname(realGit.stdout)}:/usr/bin:/bin`,
        ARCHITECTURE_REAL_GIT: realGit.stdout,
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("forced scratch init failure");
    expect(readdirSync(childTmp)).toEqual([]);
    const head = await execa("git", ["--git-dir", gitlab.dir, "show", "main:seed.txt"]);
    expect(head.stdout).toBe("seed");
  });
});
