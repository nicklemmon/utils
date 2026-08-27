import { describe, expect, it } from "vitest";

import { exitCodeForOutcome, formatOutcome } from "./output.js";

describe("exitCodeForOutcome", () => {
  it("returns 0 for a no-op outcome", () => {
    expect(
      exitCodeForOutcome({
        kind: "no-op",
        branch: "main",
        githubSha: "abc123",
        overlayFingerprint: "def456",
      }),
    ).toBe(0);
  });

  it("returns 0 for a rebuilt outcome", () => {
    expect(
      exitCodeForOutcome({
        kind: "rebuilt",
        branch: "main",
        githubSha: "abc123",
        overlayFingerprint: "def456",
        dryRun: false,
      }),
    ).toBe(0);
  });

  it("returns 0 for a merged outcome", () => {
    expect(
      exitCodeForOutcome({ kind: "merged", branch: "feature", dryRun: false }),
    ).toBe(0);
  });

  it("returns 1 for a conflict outcome", () => {
    expect(
      exitCodeForOutcome({
        kind: "conflict",
        branch: "feature",
        conflictingFiles: ["src/index.ts"],
      }),
    ).toBe(1);
  });
});

describe("formatOutcome", () => {
  it("renders a no-op outcome as human-readable text by default", () => {
    const text = formatOutcome(
      {
        kind: "no-op",
        branch: "main",
        githubSha: "abc123",
        overlayFingerprint: "def456",
      },
      { json: false },
    );

    expect(text).toBe("main is already up to date (no-op).");
  });

  it("distinguishes a dry-run rebuild from a real one in its wording", () => {
    const real = formatOutcome(
      {
        kind: "rebuilt",
        branch: "main",
        githubSha: "abc123",
        overlayFingerprint: "def456",
        dryRun: false,
      },
      { json: false },
    );
    const dry = formatOutcome(
      {
        kind: "rebuilt",
        branch: "main",
        githubSha: "abc123",
        overlayFingerprint: "def456",
        dryRun: true,
      },
      { json: false },
    );

    expect(real).not.toBe(dry);
    expect(dry).toMatch(/dry run/u);
  });

  it("renders a conflict outcome as JSON when json is true", () => {
    const text = formatOutcome(
      {
        kind: "conflict",
        branch: "feature",
        conflictingFiles: ["src/index.ts", "README.md"],
      },
      { json: true },
    );

    expect(JSON.parse(text)).toEqual({
      kind: "conflict",
      branch: "feature",
      conflictingFiles: ["src/index.ts", "README.md"],
    });
  });
});
