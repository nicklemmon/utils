import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { createAskpass } from "./askpass.js";

describe("createAskpass", () => {
  it("produces a script that echoes the given token when invoked as git would", async () => {
    const askpass = createAskpass("secret-token-value");

    try {
      const { stdout } = await execa(askpass.env.GIT_ASKPASS, ["Password:"], {
        env: askpass.env,
      });

      expect(stdout).toBe("secret-token-value");
    } finally {
      askpass.cleanup();
    }
  });
});
