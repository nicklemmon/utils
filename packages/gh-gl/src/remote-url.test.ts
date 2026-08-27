import { describe, expect, it } from "vitest";

import { isHttpsRemote } from "./remote-url.js";

describe("isHttpsRemote", () => {
  it("returns true for an https:// URL", () => {
    expect(isHttpsRemote("https://github.com/nicklemmon/utils.git")).toBe(true);
  });

  it("returns false for an ssh:// URL", () => {
    expect(isHttpsRemote("ssh://git@github.com/nicklemmon/utils.git")).toBe(false);
  });

  it("returns false for a scp-style git@host:path URL", () => {
    expect(isHttpsRemote("git@github.com:nicklemmon/utils.git")).toBe(false);
  });
});
