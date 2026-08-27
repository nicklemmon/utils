import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo } from "./test-support/fixture-repo.js";
import { sync } from "./sync.js";

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
    await execa("git", [
      "-C",
      gitlab.dir,
      "branch",
      "prototype",
      "HEAD",
    ]);

    const result = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      branch: "prototype",
      dryRun: false,
    });

    expect(result.kind).toBe("merged");
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

    const beforeSha = (
      await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])
    ).stdout;

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
    });

    const afterSha = (
      await execa("git", ["-C", gitlab.dir, "rev-parse", "prototype"])
    ).stdout;

    expect(afterSha).toBe(beforeSha);
  });
});
