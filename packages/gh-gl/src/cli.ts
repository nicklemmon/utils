#!/usr/bin/env node
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const VarlockPackageJsonSchema = z.object({
  name: z.string(),
  bin: z.object({ varlock: z.string() }).optional(),
});

/**
 * Find the installed `varlock` package's own directory. `varlock`'s `package.json` doesn't expose a
 * `./package.json` export subpath, so it can't be resolved directly — instead, resolve its main
 * entry point (which _is_ exported) and walk up to the nearest `package.json` named `varlock`.
 *
 * @returns The absolute path to varlock's package directory.
 */
function resolveVarlockPackageDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve("varlock")));

  for (;;) {
    const candidate = path.join(dir, "package.json");

    if (existsSync(candidate)) {
      const packageJson: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      const parsed = VarlockPackageJsonSchema.safeParse(packageJson);

      if (parsed.success && parsed.data.name === "varlock") {
        return dir;
      }
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      throw new Error("Could not locate the installed varlock package");
    }

    dir = parent;
  }
}

/**
 * Resolve the `varlock` CLI's own script path on disk, rather than relying on `PATH` (which isn't
 * guaranteed to include it for a global install).
 *
 * @returns The absolute path to varlock's bin script.
 */
function resolveVarlockBin(): string {
  const packageDir = resolveVarlockPackageDir();
  const packageJson: unknown = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  const { bin } = VarlockPackageJsonSchema.parse(packageJson);

  if (bin === undefined) {
    throw new Error("The installed varlock package has no bin entry");
  }

  return path.join(packageDir, bin.varlock);
}

const ErrorWithMessageSchema = z.object({ message: z.string() });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- I/O boundary parser for a caught exception of unknown shape.
function errorMessage(error: unknown): string {
  const parsed = ErrorWithMessageSchema.safeParse(error);

  return parsed.success ? parsed.data.message : "Unknown error";
}

let varlockBin: string;

try {
  varlockBin = resolveVarlockBin();
} catch (error) {
  console.error(`gh-gl: could not start varlock: ${errorMessage(error)}`);
  process.exit(2);
}

const distDir = import.meta.dirname;
const packageDir = path.dirname(distDir);
const cliImplPath = path.join(distDir, "cli-impl.js");

const result = await execa(
  process.execPath,
  [
    varlockBin,
    "run",
    "--path",
    packageDir,
    "--",
    process.execPath,
    cliImplPath,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", reject: false },
);

process.exit(result.exitCode ?? 1);
