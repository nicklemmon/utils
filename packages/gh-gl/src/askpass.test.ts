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
      createDirectory: (): string => helperDir,
      writeScript: (): void => {
        calls.push("write");
        throw new Error("script write failed");
      },
      makeExecutable: (): void => {
        calls.push("chmod");
      },
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
      createDirectory: (): string => helperDir,
      writeScript: (): void => {
        calls.push("write");
      },
      makeExecutable: (): void => {
        calls.push("chmod");
        throw new Error("script chmod failed");
      },
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
      createDirectory: (): string => "/scratch/askpass-test",
      writeScript: (): void => {
        calls.push("write");
      },
      makeExecutable: (): void => {
        calls.push("chmod");
        throw setupError;
      },
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
