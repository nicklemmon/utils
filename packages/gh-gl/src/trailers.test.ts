import { describe, expect, it } from "vitest";

import { formatSyncTrailers, parseSyncTrailers } from "./trailers.js";

describe("parseSyncTrailers", () => {
  it("reads both trailers out of a commit message", () => {
    const message = [
      "Sync GitHub into GitLab",
      "",
      "Synced-from-github: abc123",
      "Synced-from-overlay: def456",
    ].join("\n");

    expect(parseSyncTrailers(message)).toEqual({
      githubSha: "abc123",
      overlayFingerprint: "def456",
    });
  });

  it("returns undefined when a trailer is missing", () => {
    const message = ["Initial commit", "", "Synced-from-github: abc123"].join("\n");

    expect(parseSyncTrailers(message)).toBeUndefined();
  });

  it("returns undefined when there are no trailers at all", () => {
    expect(parseSyncTrailers("Initial commit")).toBeUndefined();
  });
});

describe("formatSyncTrailers", () => {
  it("renders both trailers on their own lines", () => {
    const trailers = { githubSha: "abc123", overlayFingerprint: "def456" };

    expect(formatSyncTrailers(trailers)).toBe(
      "Synced-from-github: abc123\nSynced-from-overlay: def456",
    );
  });

  it("round-trips through parseSyncTrailers", () => {
    const trailers = { githubSha: "abc123", overlayFingerprint: "def456" };
    const message = `Sync GitHub into GitLab\n\n${formatSyncTrailers(trailers)}`;

    expect(parseSyncTrailers(message)).toEqual(trailers);
  });
});
