import { describe, expect, it, vi } from "vitest";

import type { Askpass } from "./askpass.js";

import { withScratchRepo, withSyncAskpass } from "./resources.js";

describe("withScratchRepo", () => {
  it("removes an allocated directory when initialization fails", async () => {
    const calls: string[] = [];
    const initError = new Error("git init failed");

    await expect(
      withScratchRepo(
        async () => {
          await Promise.resolve();
          return "unused";
        },
        {
          createDirectory: (): string => {
            calls.push("allocate");
            return "/tmp/gh-gl-scratch-test";
          },
          initialize: async () => {
            calls.push("initialize");
            await Promise.resolve();
            throw initError;
          },
          removeDirectory: (): void => {
            calls.push("cleanup");
          },
        },
      ),
    ).rejects.toBe(initError);

    expect(calls).toEqual(["allocate", "initialize", "cleanup"]);
  });

  it("retains the work error when cleanup also fails", async () => {
    const workError = new Error("fetch failed");
    const cleanupError = new Error("scratch removal failed");

    await expect(
      withScratchRepo(
        async () => {
          await Promise.resolve();
          throw workError;
        },
        {
          createDirectory: (): string => "/tmp/gh-gl-scratch-test",
          initialize: async () => {
            await Promise.resolve();
          },
          removeDirectory: (): void => {
            throw cleanupError;
          },
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("fetch failed"),
      errors: [workError, cleanupError],
    });
  });
});

describe("withSyncAskpass", () => {
  it("preserves the work error object when cleanup succeeds", async () => {
    const workError = new Error("sync work failed");
    const cleanups: string[] = [];

    await expect(
      withSyncAskpass(
        { githubToken: "github" },
        async () => {
          await Promise.resolve();
          throw workError;
        },
        () => ({
          env: { GIT_ASKPASS: "github", GIT_ASKPASS_TOKEN: "token" },
          cleanup: (): void => {
            cleanups.push("github");
          },
        }),
      ),
    ).rejects.toBe(workError);

    expect(cleanups).toEqual(["github"]);
  });

  it("cleans the first helper when creating the second helper fails", async () => {
    const calls: string[] = [];
    const createHelper = vi.fn<(token: string) => Askpass>();
    createHelper
      .mockImplementationOnce((token) => {
        calls.push(`create:${token}`);
        return {
          env: { GIT_ASKPASS: "github", GIT_ASKPASS_TOKEN: token },
          cleanup: (): void => {
            calls.push("cleanup:github-helper");
          },
        };
      })
      .mockImplementationOnce((token) => {
        calls.push(`create:${token}`);
        throw new Error("second helper setup failed");
      });

    await expect(
      withSyncAskpass(
        { githubToken: "github-token", gitlabToken: "gitlab-token" },
        async () => {
          await Promise.resolve();
          return "unused";
        },
        createHelper,
      ),
    ).rejects.toThrow("second helper setup failed");

    expect(calls).toEqual(["create:github-token", "create:gitlab-token", "cleanup:github-helper"]);
  });

  it("attempts every cleanup and keeps the work error first", async () => {
    const calls: string[] = [];
    const firstCleanupError = new Error("gitlab helper removal failed");
    const secondCleanupError = new Error("github helper removal failed");
    const workError = new Error("sync work failed");
    const createHelper = vi.fn<(token: string) => Askpass>();
    createHelper
      .mockImplementationOnce((token) => ({
        env: { GIT_ASKPASS: "github", GIT_ASKPASS_TOKEN: token },
        cleanup: (): void => {
          calls.push("github");
          throw secondCleanupError;
        },
      }))
      .mockImplementationOnce((token) => ({
        env: { GIT_ASKPASS: "gitlab", GIT_ASKPASS_TOKEN: token },
        cleanup: (): void => {
          calls.push("gitlab");
          throw firstCleanupError;
        },
      }));

    await expect(
      withSyncAskpass(
        { githubToken: "github", gitlabToken: "gitlab" },
        async () => {
          await Promise.resolve();
          throw workError;
        },
        createHelper,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("sync work failed"),
      errors: [workError, firstCleanupError, secondCleanupError],
    });

    expect(calls).toEqual(["gitlab", "github"]);
  });

  it("surfaces cleanup failure after successful work", async () => {
    await expect(
      withSyncAskpass(
        { githubToken: "github" },
        async () => {
          await Promise.resolve();
          return "result";
        },
        () => ({
          env: { GIT_ASKPASS: "github", GIT_ASKPASS_TOKEN: "token" },
          cleanup: (): void => {
            throw new Error("helper cleanup failed");
          },
        }),
      ),
    ).rejects.toThrow("helper cleanup failed");
  });
});
