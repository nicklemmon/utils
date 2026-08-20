import { describe, expect, it } from "vitest";

import { parseNonEmptyString } from "./index.js";

describe("parseNonEmptyString", () => {
  it("returns the string when it is non-empty", () => {
    expect(parseNonEmptyString("hello")).toBe("hello");
  });

  it("throws when the value is an empty string", () => {
    expect(() => {
      parseNonEmptyString("");
    }).toThrow("Too small");
  });

  it("throws when the value is not a string", () => {
    expect(() => {
      parseNonEmptyString(1);
    }).toThrow("Invalid input");
  });
});
