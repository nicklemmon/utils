import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  checkPackagesDirectory,
  problemsForConfigExport,
  problemsForPackage,
  type PackageConfigCheck,
} from "./check-packages.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const validConfig = {
  entry: ["src/index.ts"],
  format: "esm",
  attw: { profile: "esm-only", level: "error", ignoreRules: ["false-cjs"] },
  publint: true,
};
const tempDirectories: string[] = [];

const rootScriptsSchema = z.object({
  scripts: z.object({
    qa: z.string(),
    "check-packaging": z.string(),
  }),
});

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function target(isPrivate: boolean, config: PackageConfigCheck["config"]): PackageConfigCheck {
  return {
    directoryName: "demo",
    packageName: "@nicklemmon/demo",
    isPrivate,
    config,
  };
}

function createPackagesDirectory(label: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `packaging-check-${label}-`));
  tempDirectories.push(directory);
  return directory;
}

function writePackage(
  packagesDirectory: string,
  directoryName: string,
  input: {
    readonly manifest: {
      readonly name: string;
      readonly type: "module";
      readonly private?: boolean;
    };
    readonly config?: string;
  },
): void {
  const packageDirectory = path.join(packagesDirectory, directoryName);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify(input.manifest),
    "utf8",
  );
  if (input.config === undefined) return;
  writeFileSync(path.join(packageDirectory, "tsdown.config.ts"), input.config, "utf8");
}

describe("problemsForConfigExport", () => {
  it("accepts the repo attw and publint settings", () => {
    expect(problemsForConfigExport(validConfig)).toEqual([]);
  });

  it("accepts publint options when the check stays enabled", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "esm-only", level: "error", enabled: true },
        publint: { enabled: true },
      }),
    ).toEqual([]);
  });

  it("reports a missing attw block and a missing publint block", () => {
    expect(problemsForConfigExport({ format: "esm" })).toEqual([
      'attw is missing. Set profile to "esm-only" and level to "error".',
      "publint is missing. Set it to true.",
    ]);
  });

  it("rejects an attw level that does not fail the build", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "esm-only", level: "warn" },
        publint: true,
      }),
    ).toEqual(['attw.level must be "error".']);
  });

  it("rejects an attw profile other than esm-only", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "strict", level: "error" },
        publint: true,
      }),
    ).toEqual(['attw.profile must be "esm-only".']);
  });

  it("rejects attw when it is only turned on with defaults", () => {
    expect(problemsForConfigExport({ attw: true, publint: true })).toEqual([
      'attw must be an object with profile "esm-only" and level "error".',
    ]);
  });

  it("rejects attw when enabled is not always true", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "esm-only", level: "error", enabled: "ci-only" },
        publint: true,
      }),
    ).toEqual(["attw.enabled must be true."]);
  });

  it("rejects publint when it is off", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "esm-only", level: "error" },
        publint: false,
      }),
    ).toEqual(["publint must be true, or an options object that stays enabled."]);
  });

  it("rejects publint options that disable the check", () => {
    expect(
      problemsForConfigExport({
        attw: { profile: "esm-only", level: "error" },
        publint: { enabled: false },
      }),
    ).toEqual(["publint.enabled must be true."]);
  });

  it("rejects an empty config array", () => {
    expect(problemsForConfigExport([])).toEqual([
      "tsdown config is an empty array. Each entry needs attw and publint.",
    ]);
  });

  it("checks every config object in an array", () => {
    expect(problemsForConfigExport([validConfig, { format: "esm" }])).toEqual([
      'config[1].attw is missing. Set profile to "esm-only" and level to "error".',
      "config[1].publint is missing. Set it to true.",
    ]);
  });

  it("rejects a function export", () => {
    expect(problemsForConfigExport(() => validConfig)).toEqual([
      "tsdown config must be an object with attw and publint.",
    ]);
  });
});

describe("problemsForPackage", () => {
  it("requires a tsdown config from a publishable package", () => {
    expect(problemsForPackage(target(false, { kind: "missing" }))).toEqual([
      '@nicklemmon/demo (packages/demo): publishable package is missing tsdown.config.ts. Set attw.profile to "esm-only", attw.level to "error", and publint to true.',
    ]);
  });

  it("allows a private package to omit tsdown config", () => {
    expect(problemsForPackage(target(true, { kind: "missing" }))).toEqual([]);
  });

  it("still checks a private package that has a tsdown config", () => {
    expect(
      problemsForPackage(
        target(true, {
          kind: "exported",
          defaultExport: { attw: { profile: "esm-only", level: "error" } },
        }),
      ),
    ).toEqual(["@nicklemmon/demo (packages/demo): publint is missing. Set it to true."]);
  });

  it("reports a config file that fails to load", () => {
    expect(
      problemsForPackage(target(true, { kind: "load-error", detail: "Unexpected token" })),
    ).toEqual(["@nicklemmon/demo (packages/demo): cannot load tsdown.config.ts. Unexpected token"]);
  });
});

describe("checkPackagesDirectory", () => {
  it("reports a publishable package that omits attw and publint", async () => {
    const packagesDirectory = createPackagesDirectory("omit");
    writePackage(packagesDirectory, "demo", {
      manifest: { name: "@nicklemmon/demo", type: "module" },
      config: "export default { format: 'esm' };\n",
    });

    const report = await checkPackagesDirectory(packagesDirectory);

    expect(report.packageNames).toEqual(["@nicklemmon/demo"]);
    expect(report.problems).toEqual([
      '@nicklemmon/demo (packages/demo): attw is missing. Set profile to "esm-only" and level to "error".',
      "@nicklemmon/demo (packages/demo): publint is missing. Set it to true.",
    ]);
  });

  it("reports a publishable package with no tsdown config file", async () => {
    const packagesDirectory = createPackagesDirectory("missing-file");
    writePackage(packagesDirectory, "demo", {
      manifest: { name: "@nicklemmon/demo", type: "module" },
    });

    const report = await checkPackagesDirectory(packagesDirectory);

    expect(report.problems).toEqual([
      '@nicklemmon/demo (packages/demo): publishable package is missing tsdown.config.ts. Set attw.profile to "esm-only", attw.level to "error", and publint to true.',
    ]);
  });

  it("skips a private toolchain package with no tsdown config", async () => {
    const packagesDirectory = createPackagesDirectory("private");
    writePackage(packagesDirectory, "tool", {
      manifest: { name: "@repo/tool", private: true, type: "module" },
    });

    const report = await checkPackagesDirectory(packagesDirectory);

    expect(report).toEqual({ packageNames: ["@repo/tool"], problems: [] });
  });

  it("accepts a config file that sets attw and publint", async () => {
    const packagesDirectory = createPackagesDirectory("valid");
    writePackage(packagesDirectory, "demo", {
      manifest: { name: "@nicklemmon/demo", type: "module" },
      config: 'export default { attw: { profile: "esm-only", level: "error" }, publint: true };\n',
    });

    const report = await checkPackagesDirectory(packagesDirectory);

    expect(report.problems).toEqual([]);
  });

  it("accepts the packages in this repo", async () => {
    const report = await checkPackagesDirectory(path.join(repoRoot, "packages"));

    expect(report.packageNames).toContain("@nicklemmon/example");
    expect(report.packageNames).toContain("@nicklemmon/gh-gl");
    expect(report.packageNames).toContain("@repo/anti-slop");
    expect(report.problems).toEqual([]);
  });
});

describe("repo wiring", () => {
  it("runs the packaging check from qa", () => {
    const rootPackageJson: unknown = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const scripts = rootScriptsSchema.parse(rootPackageJson).scripts;

    expect(scripts["check-packaging"]).toBe("node packages/packaging-check/src/cli.ts");
    expect(scripts.qa).toContain("npm run check-packaging");
  });

  it("exits successfully for this repo", () => {
    const result = spawnSync(process.execPath, ["packages/packaging-check/src/cli.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
