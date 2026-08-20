import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseNonEmptyString } from "./index.js";

describe("parseNonEmptyString", () => {
  it("returns the string when it is non-empty", () => {
    expect(parseNonEmptyString("hello")).toBe("hello");
  });

  it("throws when the value is an empty string", () => {
    expect(() => {
      parseNonEmptyString("");
    }).toThrow(ZodError);
  });

  it("throws when the value is not a string", () => {
    expect(() => {
      parseNonEmptyString(1);
    }).toThrow(ZodError);
  });
});
