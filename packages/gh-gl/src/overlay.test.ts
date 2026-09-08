import {
  existsSync,
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

import { copyOverlayOnto } from "./overlay.js";

describe("copyOverlayOnto", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("overwrites a file that exists in both the destination and the overlay", async () => {
    const destDir = mkdtempSync(path.join(tmpdir(), "gh-gl-dest-"));
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(destDir, { recursive: true, force: true });
      rmSync(overlayDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(destDir, "README.md"), "from github");
    writeFileSync(path.join(overlayDir, "README.md"), "from overlay");

    await copyOverlayOnto(overlayDir, destDir);

    expect(readFileSync(path.join(destDir, "README.md"), "utf8")).toBe("from overlay");
  });

  it("copies dotfiles without copying Git repository metadata", async () => {
    const destDir = mkdtempSync(path.join(tmpdir(), "gh-gl-dest-"));
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(destDir, { recursive: true, force: true });
      rmSync(overlayDir, { recursive: true, force: true });
    });
    mkdirSync(path.join(overlayDir, ".git"));
    writeFileSync(path.join(overlayDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(overlayDir, ".gitlab-ci.yml"), "stages: []\n");

    await copyOverlayOnto(overlayDir, destDir);

    expect(readFileSync(path.join(destDir, ".gitlab-ci.yml"), "utf8")).toBe("stages: []\n");
    expect(existsSync(path.join(destDir, ".git", "HEAD"))).toBe(false);
  });

  it("preserves the text of relative symlinks", async () => {
    const destDir = mkdtempSync(path.join(tmpdir(), "gh-gl-dest-"));
    const overlayDir = mkdtempSync(path.join(tmpdir(), "gh-gl-overlay-"));

    cleanups.push(() => {
      rmSync(destDir, { recursive: true, force: true });
      rmSync(overlayDir, { recursive: true, force: true });
    });
    mkdirSync(path.join(overlayDir, "config"));
    symlinkSync("../shared.json", path.join(overlayDir, "config", "current.json"));
    writeFileSync(path.join(overlayDir, "shared.json"), "{}\n");

    await copyOverlayOnto(overlayDir, destDir);

    expect(readlinkSync(path.join(destDir, "config", "current.json"))).toBe("../shared.json");
  });
});
