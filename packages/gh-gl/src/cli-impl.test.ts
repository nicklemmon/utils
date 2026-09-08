import { execa } from "execa";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("gh-gl CLI", () => {
  const packageDir = path.resolve(import.meta.dirname, "..");
  const buildDir = mkdtempSync(path.join(packageDir, ".gh-gl-cli-test-"));
  const cliPath = path.join(buildDir, "cli-impl.mjs");

  beforeAll(async () => {
    const tsdownPath = path.resolve(packageDir, "../../node_modules/.bin/tsdown");

    await execa(
      tsdownPath,
      [
        "src/cli-impl.ts",
        "--no-config",
        "--out-dir",
        buildDir,
        "--platform",
        "node",
        "--format",
        "esm",
        "--logLevel",
        "error",
      ],
      { cwd: packageDir },
    );
  });

  afterAll(() => {
    rmSync(buildDir, { recursive: true, force: true });
  });

  it("prints one JSON error object when Commander rejects JSON-mode input", async () => {
    const result = await execa(process.execPath, [cliPath, "sync", "--json"], { reject: false });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe(
      JSON.stringify({
        kind: "error",
        message: "error: required option '--github-url <url>' not specified",
      }),
    );
    expect(result.stderr).toBe("");
  });
});
