#!/usr/bin/env node
import { execa } from "execa";
import { readFileSync } from "node:fs";
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
 * entry point (which _is_ exported) and locate the enclosing `node_modules/varlock` directory. This
 * doesn't depend on the entry point living next to `package.json` on disk (unlike walking up parent
 * directories looking for one), only on the standard `node_modules/<package>/...` install layout.
 *
 * @returns The absolute path to varlock's package directory.
 */
function resolveVarlockPackageDir(): string {
  const entryPath = fileURLToPath(import.meta.resolve("varlock"));
  const marker = `${path.sep}node_modules${path.sep}varlock${path.sep}`;
  const markerIndex = entryPath.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error("Could not locate the installed varlock package");
  }

  return entryPath.slice(0, markerIndex + marker.length - 1);
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

// `result.exitCode` is undefined when the child process never produced a normal exit
// (e.g. it was killed by a signal, or failed to spawn at all) — that's a real error
// (tier 2), not the merge-conflict tier (1) that a fallback of 1 would collide with.
process.exit(result.exitCode ?? 2);
