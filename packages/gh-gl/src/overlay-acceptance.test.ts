import { execa } from "execa";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SyncOptions } from "./sync.js";
import type { BareFixtureRepo } from "./test-support/fixture-repo.js";

import { sync } from "./sync.js";
import { createBareFixtureRepo, createFixtureRepo } from "./test-support/fixture-repo.js";

type OverlayFixture = Readonly<{
  gitlab: BareFixtureRepo;
  overlayDir: string;
  options: SyncOptions;
}>;

const rebuiltSchema = z.object({ kind: z.literal("rebuilt"), overlayFingerprint: z.string() });

describe("overlay acceptance", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function fixture(): Promise<OverlayFixture> {
    const github = await createFixtureRepo();
    cleanups.push(github.cleanup);
    await github.commit("Seed upstream", {
      "README.md": "upstream",
      ".gitattributes": "*.txt -text\n",
      "upstream.txt": "upstream\r\n",
      ".gitignore": "upstream-ignored.txt\n",
      "tracked.txt": "upstream tracked",
    });
    const gitlab = await createBareFixtureRepo({ "seed.txt": "seed" });
    cleanups.push(gitlab.cleanup);
    const overlayDir = mkdtempSync(path.join(tmpdir(), "overlay-acceptance-"));
    cleanups.push(() => {
      rmSync(overlayDir, { recursive: true, force: true });
    });
    const options = { githubUrl: github.dir, gitlabUrl: gitlab.dir, overlayDir, dryRun: false };
    return { gitlab, overlayDir, options };
  }

  it("publishes files ignored by upstream and preserves Git modes and symlink targets", async () => {
    const { gitlab, overlayDir, options } = await fixture();
    writeFileSync(path.join(overlayDir, "upstream-ignored.txt"), "required overlay content");
    writeFileSync(path.join(overlayDir, "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(overlayDir, "run.sh"), 0o755);
    symlinkSync("upstream-ignored.txt", path.join(overlayDir, "current"));
    mkdirSync(path.join(overlayDir, ".git"));
    writeFileSync(path.join(overlayDir, ".git", "secret"), "excluded metadata");

    expect(await sync(options)).toMatchObject({ kind: "rebuilt", dryRun: false });
    const content = await execa("git", [
      "--git-dir",
      gitlab.dir,
      "show",
      "main:upstream-ignored.txt",
    ]);
    expect(content.stdout).toBe("required overlay content");
    const entries = await execa("git", [
      "--git-dir",
      gitlab.dir,
      "ls-tree",
      "main",
      "run.sh",
      "current",
      ".git",
    ]);
    expect(entries.stdout).toMatch(/^100755 blob [a-f\d]+\trun\.sh$/mu);
    expect(entries.stdout).toMatch(/^120000 blob [a-f\d]+\tcurrent$/mu);
    expect(entries.stdout).not.toContain("\t.git");
    const target = await execa("git", ["--git-dir", gitlab.dir, "show", "main:current"]);
    expect(target.stdout).toBe("upstream-ignored.txt");
    const before = await execa("git", ["--git-dir", gitlab.dir, "rev-parse", "main"]);
    expect(await sync(options)).toMatchObject({ kind: "no-op" });
    const after = await execa("git", ["--git-dir", gitlab.dir, "rev-parse", "main"]);
    expect(after.stdout).toBe(before.stdout);
  });

  it("preserves upstream bytes when overlay attributes select a different text format", async () => {
    const { gitlab, overlayDir, options } = await fixture();
    writeFileSync(path.join(overlayDir, ".gitattributes"), "*.txt text eol=lf\n");
    writeFileSync(path.join(overlayDir, "payload.txt"), "overlay\r\n");
    expect(await sync(options)).toMatchObject({ kind: "rebuilt" });
    const upstream = await execa("git", ["--git-dir", gitlab.dir, "show", "main:upstream.txt"], {
      stripFinalNewline: false,
    });
    expect(upstream.stdout).toBe("upstream\r\n");
    const payload = await execa("git", ["--git-dir", gitlab.dir, "show", "main:payload.txt"], {
      stripFinalNewline: false,
    });
    expect(payload.stdout).toBe("overlay\r\n");
  });

  it("detects edits to overlay files excluded by its own ignore rules", async () => {
    const { gitlab, overlayDir, options } = await fixture();
    writeFileSync(path.join(overlayDir, ".gitignore"), "tracked.txt\nnew.txt\n");
    writeFileSync(path.join(overlayDir, "tracked.txt"), "first tracked");
    writeFileSync(path.join(overlayDir, "new.txt"), "new ignored file");
    const first = await sync(options);
    expect(first).toMatchObject({ kind: "rebuilt" });
    writeFileSync(path.join(overlayDir, "tracked.txt"), "second tracked");
    const second = await sync(options);
    expect(second).toMatchObject({ kind: "rebuilt" });
    expect(rebuiltSchema.parse(second).overlayFingerprint).not.toBe(
      rebuiltSchema.parse(first).overlayFingerprint,
    );
    const tracked = await execa("git", ["--git-dir", gitlab.dir, "show", "main:tracked.txt"]);
    expect(tracked.stdout).toBe("second tracked");
    const added = await execa("git", ["--git-dir", gitlab.dir, "show", "main:new.txt"]);
    expect(added.stdout).toBe("new ignored file");
  });
});
