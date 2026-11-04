import { execa } from "execa";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  commitAll,
  commitEmpty,
  commitStagedChanges,
  initScratchRepo,
  resolveRef,
  setSymbolicHead,
} from "./git.js";
import { applyCapturedOverlay, captureOverlay } from "./overlay.js";
import { sync } from "./sync.js";
import { createBareFixtureRepo, createFixtureRepo } from "./test-support/fixture-repo.js";

describe("captured overlay", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** Create an initialized scratch repo and register its cleanup. */
  async function scratch(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-scratch-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    await initScratchRepo(dir);
    await setSymbolicHead(dir, "refs/heads/main");
    await commitEmpty(dir, "Base");
    return dir;
  }

  it("captures ordinary files and omits every .git entry", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    mkdirSync(path.join(overlayDir, "nested", ".git"), { recursive: true });
    writeFileSync(path.join(overlayDir, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(overlayDir, "ignored.txt"), "kept\n");
    writeFileSync(path.join(overlayDir, "nested", ".git", "secret"), "omitted\n");

    const snapshot = await captureOverlay(scratchDir, overlayDir);
    await applyCapturedOverlay(scratchDir, snapshot, "HEAD");

    expect(readFileSync(path.join(scratchDir, "ignored.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(path.join(scratchDir, "nested", ".git"))).toBe(false);
  });

  it("applies captured bytes after source edits and deletions", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, "kept.bin"), Buffer.from([0, 255, 17]));
    writeFileSync(path.join(overlayDir, "deleted-after-capture.txt"), "captured\n");

    const snapshot = await captureOverlay(scratchDir, overlayDir);
    writeFileSync(path.join(overlayDir, "kept.bin"), "changed after capture");
    rmSync(path.join(overlayDir, "deleted-after-capture.txt"));
    await applyCapturedOverlay(scratchDir, snapshot, "HEAD");

    expect(readFileSync(path.join(scratchDir, "kept.bin"))).toEqual(Buffer.from([0, 255, 17]));
    expect(readFileSync(path.join(scratchDir, "deleted-after-capture.txt"), "utf8")).toBe(
      "captured\n",
    );
  });

  it("captures and applies regular files larger than 100 MB", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    const payload = Buffer.alloc(100_000_001, 0xa5);
    payload.set(Buffer.from("overlay-start"), 0);
    payload.set(Buffer.from("overlay-end"), payload.length - 11);
    const overlayFile = path.join(overlayDir, "large.bin");
    writeFileSync(overlayFile, payload);
    const { stdout: expectedBlob } = await execa("git", [
      "-C",
      scratchDir,
      "hash-object",
      "--no-filters",
      overlayFile,
    ]);

    const snapshot = await captureOverlay(scratchDir, overlayDir);
    await applyCapturedOverlay(scratchDir, snapshot, "HEAD");

    const { stdout: appliedBlob } = await execa("git", [
      "-C",
      scratchDir,
      "hash-object",
      "--no-filters",
      path.join(scratchDir, "large.bin"),
    ]);
    expect(appliedBlob).toBe(expectedBlob);
  }, 30_000);

  it("settles the blob stream when Git cannot read a captured object", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, "missing-blob.bin"), "captured bytes");
    const snapshot = await captureOverlay(scratchDir, overlayDir);
    const { stdout: treeEntry } = await execa("git", ["-C", scratchDir, "ls-tree", snapshot.tree]);
    const parsedTreeEntry = z
      .string()
      .regex(/^100644 blob [0-9a-f]{40}\tmissing-blob\.bin$/u)
      .parse(treeEntry);
    const blobId = z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .parse(parsedTreeEntry.slice(12, 52));
    const blobPath = path.join(scratchDir, ".git", "objects", blobId.slice(0, 2), blobId.slice(2));
    rmSync(blobPath);

    await expect(applyCapturedOverlay(scratchDir, snapshot, "HEAD")).rejects.toMatchObject({
      stderr: expect.stringContaining("bad file"),
      exitCode: 128,
    });
  });

  it("changes the fingerprint when only the executable bit changes", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    const script = path.join(overlayDir, "run.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");

    const before = await captureOverlay(scratchDir, overlayDir);
    chmodSync(script, 0o755);
    const after = await captureOverlay(scratchDir, overlayDir);

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("ignores group and other execute bits like Git", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    const script = path.join(overlayDir, "run.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o611);

    const snapshot = await captureOverlay(scratchDir, overlayDir);
    const { stdout } = await execa("git", ["-C", scratchDir, "ls-tree", snapshot.tree]);

    expect(stdout).toMatch(/^100644 blob [0-9a-f]{40}\trun\.sh$/u);
  });

  it("returns the same fingerprint for unchanged overlay content", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    const first = await captureOverlay(scratchDir, overlayDir);
    const second = await captureOverlay(scratchDir, overlayDir);

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("changes the fingerprint when overlay content changes", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    const overlayFile = path.join(overlayDir, ".gitlab-ci.yml");
    writeFileSync(overlayFile, "stages: []\n");

    const before = await captureOverlay(scratchDir, overlayDir);
    writeFileSync(overlayFile, "stages: [build]\n");
    const after = await captureOverlay(scratchDir, overlayDir);

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("keeps captured bytes when .gitattributes requests line ending and clean filter conversion", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(
      path.join(overlayDir, ".gitattributes"),
      "payload.txt text eol=crlf filter=replace\n",
    );
    const payload = Buffer.from("first\nsecond\n");
    writeFileSync(path.join(overlayDir, "payload.txt"), payload);
    await execa("git", [
      "-C",
      scratchDir,
      "config",
      "filter.replace.clean",
      "sed s/first/filtered/",
    ]);

    const snapshot = await captureOverlay(scratchDir, overlayDir);
    await applyCapturedOverlay(scratchDir, snapshot, "HEAD");
    await commitStagedChanges(scratchDir, "Overlay");
    const { stdout } = await execa(
      "git",
      ["-C", scratchDir, "cat-file", "blob", "HEAD:payload.txt"],
      {
        encoding: "buffer",
        stripFinalNewline: false,
      },
    );

    expect(Buffer.from(stdout)).toEqual(payload);
  });

  it("replaces destination files, directories, and symlink parents without following them", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "gh-gl-outside-"));
    cleanups.push(
      () => {
        rmSync(overlayDir, { recursive: true, force: true });
      },
      () => {
        rmSync(outsideDir, { recursive: true, force: true });
      },
    );

    writeFileSync(path.join(scratchDir, "to-directory"), "old file");
    mkdirSync(path.join(scratchDir, "to-file", "child"), { recursive: true });
    writeFileSync(path.join(scratchDir, "to-file", "child", "old"), "old directory");
    writeFileSync(path.join(outsideDir, "keep"), "outside");
    symlinkSync(outsideDir, path.join(scratchDir, "linked-parent"));
    mkdirSync(path.join(overlayDir, "to-directory"));
    writeFileSync(path.join(overlayDir, "to-directory", "new"), "new directory");
    writeFileSync(path.join(overlayDir, "to-file"), "new file");
    mkdirSync(path.join(overlayDir, "linked-parent"));
    writeFileSync(path.join(overlayDir, "linked-parent", "new"), "inside destination");

    await commitAll(scratchDir, "Upstream paths");
    const upstreamCommit = await resolveRef(scratchDir, "HEAD");
    await applyCapturedOverlay(
      scratchDir,
      await captureOverlay(scratchDir, overlayDir),
      upstreamCommit,
    );
    await commitStagedChanges(scratchDir, "Overlay paths");

    expect(readFileSync(path.join(scratchDir, "to-directory", "new"), "utf8")).toBe(
      "new directory",
    );
    expect(lstatSync(path.join(scratchDir, "to-file")).isFile()).toBe(true);
    expect(readFileSync(path.join(scratchDir, "to-file"), "utf8")).toBe("new file");
    expect(lstatSync(path.join(scratchDir, "linked-parent")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(scratchDir, "linked-parent", "new"), "utf8")).toBe(
      "inside destination",
    );
    expect(readFileSync(path.join(outsideDir, "keep"), "utf8")).toBe("outside");
    expect(existsSync(path.join(outsideDir, "new"))).toBe(false);
  });

  it("preserves symlink target text and executable mode", async () => {
    const scratchDir = await scratch();
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(overlayDir, "run.sh"), 0o755);
    symlinkSync("../target with spaces", path.join(overlayDir, "link"));

    await applyCapturedOverlay(scratchDir, await captureOverlay(scratchDir, overlayDir), "HEAD");

    expect(readlinkSync(path.join(scratchDir, "link"))).toBe("../target with spaces");
    // oxlint-disable-next-line eslint/no-bitwise -- Git executable mode uses the Unix execute bits.
    expect(lstatSync(path.join(scratchDir, "run.sh")).mode & 0o111).toBe(0o111);
  });

  it("recaptures the source after a real remote hook rejects the first push", async () => {
    const github = await createFixtureRepo();
    cleanups.push(github.cleanup);
    await github.commit("Upstream", { "README.md": "upstream" });
    const gitlab = await createBareFixtureRepo({ "README.md": "old" });
    cleanups.push(gitlab.cleanup);
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(overlayDir, "from-overlay.txt"), "before first push\n");

    const hookDir = path.join(gitlab.dir, "hooks");
    const markerPath = path.join(gitlab.dir, "hooks", "gh-gl-rejected-once");
    writeFileSync(
      path.join(hookDir, "pre-receive"),
      `#!/bin/sh\nif [ ! -e '${markerPath}' ]; then\n  : > '${markerPath}'\n  printf 'after first push\\n' > '${path.join(overlayDir, "from-overlay.txt")}'\n  exit 1\nfi\nexit 0\n`,
    );
    chmodSync(path.join(hookDir, "pre-receive"), 0o755);

    const outcome = await sync({
      githubUrl: github.dir,
      gitlabUrl: gitlab.dir,
      overlayDir,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ kind: "rebuilt", dryRun: false });
    const content = await execa("git", ["--git-dir", gitlab.dir, "show", "main:from-overlay.txt"]);
    expect(content.stdout).toBe("after first push");
  });
});
