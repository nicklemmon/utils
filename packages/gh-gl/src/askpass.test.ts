import { execa } from "execa";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAskpass, createAskpassWithOperations } from "./askpass.js";

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

  it("removes its directory when script writing fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gh-gl-askpass-test-"));
    const helperDir = mkdtempSync(path.join(root, "helper-"));
    const calls: string[] = [];
    const operations = {
      /** Return the fixture helper directory. */
      createDirectory: (): string => helperDir,
      /** Fail while writing the helper script. */
      writeScript: (): void => {
        calls.push("write");
        throw new Error("script write failed");
      },
      /** Record whether executable setup runs. */
      makeExecutable: (): void => {
        calls.push("chmod");
      },
      /** Remove the fixture helper directory. */
      removeDirectory: (dir: string): void => {
        rmSync(dir, { recursive: true, force: true });
      },
    };

    try {
      expect(() => createAskpassWithOperations("token", operations)).toThrow("script write failed");
      expect(readdirSync(root)).toEqual([]);
      expect(calls).toEqual(["write"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes its directory when chmod fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gh-gl-askpass-test-"));
    const helperDir = mkdtempSync(path.join(root, "helper-"));
    const calls: string[] = [];
    const operations = {
      /** Return the fixture helper directory. */
      createDirectory: (): string => helperDir,
      /** Record successful script writing. */
      writeScript: (): void => {
        calls.push("write");
      },
      /** Fail while marking the script executable. */
      makeExecutable: (): void => {
        calls.push("chmod");
        throw new Error("script chmod failed");
      },
      /** Remove the fixture helper directory. */
      removeDirectory: (dir: string): void => {
        rmSync(dir, { recursive: true, force: true });
      },
    };

    try {
      expect(() => createAskpassWithOperations("token", operations)).toThrow("script chmod failed");
      expect(readdirSync(root)).toEqual([]);
      expect(calls).toEqual(["write", "chmod"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps setup and cleanup errors when both fail", () => {
    const setupError = new Error("script chmod failed");
    const cleanupError = new Error("helper removal failed");
    const calls: string[] = [];
    const operations = {
      /** Return the fixture helper path. */
      createDirectory: (): string => "/scratch/askpass-test",
      /** Record successful script writing. */
      writeScript: (): void => {
        calls.push("write");
      },
      /** Fail while marking the script executable. */
      makeExecutable: (): void => {
        calls.push("chmod");
        throw setupError;
      },
      /** Record and fail helper cleanup. */
      removeDirectory: (): void => {
        calls.push("cleanup");
        throw cleanupError;
      },
    };

    expect(() => createAskpassWithOperations("token", operations)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("script chmod failed"),
        errors: [setupError, cleanupError],
      }),
    );
    expect(calls).toEqual(["write", "chmod", "cleanup"]);
  });
});
