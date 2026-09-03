import { describe, expect, it } from "vitest";

import { validateTokens } from "./env.js";

describe("validateTokens", () => {
  it("returns no errors when both remotes are HTTPS with tokens present", () => {
    const errors = validateTokens({
      githubUrl: "https://github.com/nicklemmon/utils.git",
      gitlabUrl: "https://gitlab.com/nicklemmon/utils.git",
      githubToken: "gh-token",
      gitlabToken: "gl-token",
    });

    expect(errors).toEqual([]);
  });

  it("reports a missing GITHUB_TOKEN when --github-url is HTTPS", () => {
    const errors = validateTokens({
      githubUrl: "https://github.com/nicklemmon/utils.git",
      gitlabUrl: "https://gitlab.com/nicklemmon/utils.git",
      githubToken: undefined,
      gitlabToken: "gl-token",
    });

    expect(errors).toEqual(["GITHUB_TOKEN is required when --github-url is HTTPS"]);
  });

  it("does not require a token for an SSH remote, even when missing", () => {
    const errors = validateTokens({
      githubUrl: "git@github.com:nicklemmon/utils.git",
      gitlabUrl: "https://gitlab.com/nicklemmon/utils.git",
      githubToken: undefined,
      gitlabToken: "gl-token",
    });

    expect(errors).toEqual([]);
  });
});
