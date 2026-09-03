import { execa } from "execa";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sync } from "./sync.js";
import { createBareFixtureRepo, createFixtureRepo } from "./test-support/fixture-repo.js";

/**
 * Install a `pre-receive` hook on a bare repo that declines every push, so a push to it fails the
 * same way a real concurrent-writer race would (git reports it as `[remote rejected]`, which
 * `pushBranch` treats the same as a non-fast-forward rejection) — deterministically, without
 * needing two real processes to race each other.
 */
function installRejectingPreReceiveHook(bareRepoDir: string): void {
  const hookPath = path.join(bareRepoDir, "hooks", "pre-receive");

  writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
  chmodSync(hookPath, 0o755);
}

describe("sync", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("is a no-op when nothing has changed since the last sync", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    // Precondition: the GitLab repo must already have a commit on its
    // default branch before the first sync (see PLAN.md).
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const first = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(first.kind).toBe("rebuilt");

    const second = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(second.kind).toBe("no-op");
  });

  it("rebuilds when only the overlay content changes, even though GitHub hasn't", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const first = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(first.kind).toBe("rebuilt");

    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: [build]\n");

    const second = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(second.kind).toBe("rebuilt");
    expect(readFileSync(path.join(gitlab.dir, ".gitlab-ci.yml"), "utf8")).toBe("stages: [build]\n");
  });

  it("drops files deleted on GitHub's default branch from the rebuilt tree", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", {
      "README.md": "hello",
      "old-file.txt": "gone soon",
    });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(existsSync(path.join(gitlab.dir, "old-file.txt"))).toBe(true);

    await execa("git", ["-C", github.dir, "rm", "--quiet", "old-file.txt"]);
    await execa("git", ["-C", github.dir, "commit", "-m", "Remove old file"]);

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(result.kind).toBe("rebuilt");
    expect(existsSync(path.join(gitlab.dir, "old-file.txt"))).toBe(false);
    expect(readFileSync(path.join(gitlab.dir, "README.md"), "utf8")).toBe("hello");
  });

  it("does not push and reports dryRun on a dry-run rebuild", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    const seedSha = await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: true,
    });

    expect(result).toMatchObject({ kind: "rebuilt", dryRun: true });

    const { stdout: tipSha } = await execa("git", ["-C", gitlab.dir, "rev-parse", "main"]);

    expect(tipSha).toBe(seedSha);
  });

  it("throws after a rebuild push is rejected twice in a row", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createBareFixtureRepo({ ".gitkeep": "" });

    cleanups.push(gitlab.cleanup);
    // Every push to the remote fails the same way a concurrent sync run winning the race
    // would, deterministically forcing runRebuild's initial attempt and its one retry to
    // both hit the non-fast-forward rejection, exercising its real double-rejection throw.
    installRejectingPreReceiveHook(gitlab.dir);

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await expect(
      sync({
        githubUrl: github.dir,
        gitlabUrl: gitlab.dir,
        overlayDir,
        dryRun: false,
      }),
    ).rejects.toThrow(/rejected twice in a row/u);
  });

  it("merges the default branch cleanly into a prototype branch", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });
    await gitlab.commit("A prototype branch", { "prototype.md": "wip" });
    await execa("git", ["-C", gitlab.dir, "branch", "prototype", "HEAD"]);

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      branch: "prototype",
      dryRun: false,
    });

    expect(result.kind).toBe("merged");
  });

  it("does not push and reports dryRun on a dry-run merge", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });
    await gitlab.commit("A prototype branch", { "prototype.md": "wip" });
    await execa("git", ["-C", gitlab.dir, "branch", "prototype", "HEAD"]);

    const beforeSha = (await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])).stdout;

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      branch: "prototype",
      dryRun: true,
    });

    expect(result).toEqual({ kind: "merged", branch: "prototype", dryRun: true });

    const afterSha = (await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])).stdout;

    expect(afterSha).toBe(beforeSha);
  });

  it("throws instead of silently reporting success when the merge push is rejected", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createBareFixtureRepo({ ".gitkeep": "" });

    cleanups.push(gitlab.cleanup);

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    const workDir = mkdtempSync(path.join(tmpdir(), "gh-gl-work-"));

    cleanups.push(() => {
      rmSync(workDir, { recursive: true, force: true });
    });
    await execa("git", ["clone", "--quiet", gitlab.dir, workDir]);
    await execa("git", ["-C", workDir, "config", "user.email", "test@example.com"]);
    await execa("git", ["-C", workDir, "config", "user.name", "Test"]);
    await execa("git", ["-C", workDir, "config", "commit.gpgsign", "false"]);
    await execa("git", ["-C", workDir, "checkout", "-b", "prototype"]);
    writeFileSync(path.join(workDir, "prototype.md"), "wip");
    await execa("git", ["-C", workDir, "add", "-A"]);
    await execa("git", ["-C", workDir, "commit", "-m", "Prototype work"]);
    await execa("git", ["-C", workDir, "push", "origin", "prototype:prototype"]);

    // Advance main independently so main is not already an ancestor of
    // prototype's tip — otherwise merging main into prototype has nothing new
    // to bring in, git treats it as "Already up to date" with no new commit,
    // and the push that follows is a same-sha no-op that never reaches the
    // remote's pre-receive hook at all.
    await github.commit("Second commit", { "README.md": "updated" });
    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    const beforeSha = (await execa("git", ["-C", workDir, "rev-parse", "prototype"])).stdout;

    // Every push to the remote fails the same way a concurrent writer winning the race
    // would, deterministically forcing runMerge's push to hit the non-fast-forward
    // rejection and exercising its real throw — unlike the rebuild path, this never
    // retries, so one rejection must be enough to fail the whole sync() call.
    installRejectingPreReceiveHook(gitlab.dir);

    await expect(
      sync({
        githubUrl: github.dir,
        gitlabUrl: gitlab.dir,
        overlayDir,
        branch: "prototype",
        dryRun: false,
      }),
    ).rejects.toThrow(/Push to prototype was rejected/u);

    const { stdout: remoteSha } = await execa("git", [
      "--git-dir",
      gitlab.dir,
      "rev-parse",
      "prototype",
    ]);

    expect(remoteSha).toBe(beforeSha);
  });

  it("reports a conflict and leaves the prototype branch unpushed", async () => {
    const github = await createFixtureRepo();

    cleanups.push(github.cleanup);
    await github.commit("Initial commit", { "README.md": "hello" });

    const gitlab = await createFixtureRepo();

    cleanups.push(gitlab.cleanup);
    await gitlab.commit("Seed commit", { ".gitkeep": "" });

    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });
    await execa("git", ["-C", gitlab.dir, "branch", "prototype", "HEAD"]);
    await execa("git", ["-C", gitlab.dir, "checkout", "prototype"]);
    writeFileSync(path.join(gitlab.dir, "README.md"), "changed on prototype");
    await execa("git", ["-C", gitlab.dir, "add", "-A"]);
    await execa("git", ["-C", gitlab.dir, "commit", "-m", "Conflicting change"]);
    await execa("git", ["-C", gitlab.dir, "checkout", "main"]);

    const beforeSha = (await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])).stdout;

    await github.commit("Change on GitHub", { "README.md": "changed on github" });
    await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      branch: "prototype",
      dryRun: false,
    });

    expect(result).toEqual({
      kind: "conflict",
      branch: "prototype",
      conflictingFiles: ["README.md"],
      gitlabUrl: gitlab.dir,
      gitlabDefaultBranch: "main",
    });

    const afterSha = (await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])).stdout;

    expect(afterSha).toBe(beforeSha);
  });
});
