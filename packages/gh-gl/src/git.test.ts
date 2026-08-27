import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  commitAll,
  detectDefaultBranch,
  extractTree,
  fetchRef,
  fingerprintDirectory,
  initScratchRepo,
  abortMergeConflict,
  checkoutBranch,
  mergeRef,
  pushBranch,
  readCommitMessage,
  resolveRef,
  setSymbolicHead,
} from "./git.js";
import { createFixtureRepo } from "./test-support/fixture-repo.js";

describe("detectDefaultBranch", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("returns the branch HEAD points at", async () => {
    const repo = await createFixtureRepo();

    cleanups.push(repo.cleanup);
    await repo.commit("Initial commit", { "README.md": "hello" });

    await expect(detectDefaultBranch(repo.dir)).resolves.toBe("main");
  });

  it("returns undefined when the repo has no commits", async () => {
    const repo = await createFixtureRepo();

    cleanups.push(repo.cleanup);

    await expect(detectDefaultBranch(repo.dir)).resolves.toBeUndefined();
  });
});

describe("fetchRef and readCommitMessage", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("fetches a remote branch's tip and reads its commit message", async () => {
    const repo = await createFixtureRepo();

    cleanups.push(repo.cleanup);
    await repo.commit("Initial commit", { "README.md": "hello" });
    await repo.commit("Second commit\n\nWith a body.", {
      "README.md": "updated",
    });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, repo.dir, "main");

    await expect(readCommitMessage(scratchDir, "FETCH_HEAD")).resolves.toBe(
      "Second commit\n\nWith a body.\n",
    );
  });
});

describe("extractTree", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("extracts a fetched ref's tree into a destination directory", async () => {
    const repo = await createFixtureRepo();

    cleanups.push(repo.cleanup);
    await repo.commit("Initial commit", {
      "README.md": "hello",
      "src/index.ts": "export {};",
    });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));
    const destDir = mkdtempSync(path.join(tmpdir(), "gh-gl-dest-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
      rmSync(destDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, repo.dir, "main");
    await extractTree(scratchDir, "FETCH_HEAD", destDir);

    expect(readFileSync(path.join(destDir, "README.md"), "utf8")).toBe(
      "hello",
    );
    expect(readFileSync(path.join(destDir, "src/index.ts"), "utf8")).toBe(
      "export {};",
    );
  });
});

describe("fingerprintDirectory", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("returns the same fingerprint for the same content", async () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
      rmSync(overlayDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const first = await fingerprintDirectory(scratchDir, overlayDir);
    const second = await fingerprintDirectory(scratchDir, overlayDir);

    expect(first).toBe(second);
  });

  it("returns a different fingerprint when content changes", async () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
      rmSync(overlayDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const before = await fingerprintDirectory(scratchDir, overlayDir);

    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: [build]\n");

    const after = await fingerprintDirectory(scratchDir, overlayDir);

    expect(before).not.toBe(after);
  });
});

describe("resolveRef", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("resolves a fetched ref to its commit sha", async () => {
    const repo = await createFixtureRepo();

    cleanups.push(repo.cleanup);

    const sha = await repo.commit("Initial commit", { "README.md": "hello" });
    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, repo.dir, "main");

    await expect(resolveRef(scratchDir, "FETCH_HEAD")).resolves.toBe(sha);
  });
});

describe("commitAll", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("commits the current worktree contents with the given message", async () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(scratchDir, "README.md"), "hello");
    await commitAll(scratchDir, "Sync GitHub into GitLab");

    await expect(readCommitMessage(scratchDir, "HEAD")).resolves.toBe(
      "Sync GitHub into GitLab\n",
    );
  });
});

describe("pushBranch", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("returns true after a successful push", async () => {
    const remote = await createFixtureRepo();

    cleanups.push(remote.cleanup);
    await remote.commit("Initial commit", { "README.md": "hello" });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, remote.dir, "main", { localRef: "refs/heads/main" });

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(scratchDir, "README.md"), "updated");
    await setSymbolicHead(scratchDir, "refs/heads/main");
    await commitAll(scratchDir, "Update README");

    await expect(pushBranch(scratchDir, remote.dir, "main")).resolves.toBe(
      true,
    );
  });

  it("returns false when the push is rejected as non-fast-forward", async () => {
    const remote = await createFixtureRepo();

    cleanups.push(remote.cleanup);
    await remote.commit("Initial commit", { "README.md": "hello" });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, remote.dir, "main", { localRef: "refs/heads/main" });

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(scratchDir, "README.md"), "updated from scratch");
    await setSymbolicHead(scratchDir, "refs/heads/main");
    await commitAll(scratchDir, "Update from scratch");

    // The remote moves on independently, so the scratch repo's push is now
    // based on a stale parent.
    await remote.commit("Someone else's commit", {
      "README.md": "updated on the remote",
    });

    await expect(pushBranch(scratchDir, remote.dir, "main")).resolves.toBe(
      false,
    );
  });
});

describe("mergeRef and abortMergeConflict", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("reports a clean merge with no conflicts", async () => {
    const remote = await createFixtureRepo();

    cleanups.push(remote.cleanup);
    await remote.commit("Initial commit", {
      "README.md": "hello",
      "other.md": "unrelated",
    });
    await remote.commit("Change on main", { "README.md": "changed on main" });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, remote.dir, "main", {
      localRef: "refs/heads/main",
    });
    await checkoutBranch(scratchDir, "main");
    await fetchRef(scratchDir, remote.dir, "main");

    await expect(mergeRef(scratchDir, "FETCH_HEAD")).resolves.toEqual({
      kind: "clean",
    });
  });

  it("reports conflicting files and leaves the merge aborted", async () => {
    const remote = await createFixtureRepo();

    cleanups.push(remote.cleanup);
    await remote.commit("Initial commit", { "README.md": "hello" });

    const scratchDir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));

    cleanups.push(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });
    await initScratchRepo(scratchDir);
    await fetchRef(scratchDir, remote.dir, "main", {
      localRef: "refs/heads/main",
    });
    await checkoutBranch(scratchDir, "main");

    const { writeFileSync } = await import("node:fs");

    writeFileSync(path.join(scratchDir, "README.md"), "changed on target");
    await commitAll(scratchDir, "Change on target branch");
    await remote.commit("Conflicting change on main", {
      "README.md": "changed on main",
    });
    await fetchRef(scratchDir, remote.dir, "main");

    await expect(mergeRef(scratchDir, "FETCH_HEAD")).resolves.toEqual({
      kind: "conflict",
      conflictingFiles: ["README.md"],
    });

    await abortMergeConflict(scratchDir);

    const { stdout } = await execa("git", [
      "-C",
      scratchDir,
      "status",
      "--porcelain=v1",
    ]);

    expect(stdout).toBe("");
  });
});
