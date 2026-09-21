import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { checkPackagesDirectory } from "./check-packages.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const caughtErrorSchema = z.object({ message: z.string() });

try {
  const report = await checkPackagesDirectory(path.join(repoRoot, "packages"));
  if (report.problems.length > 0) {
    process.stderr.write(`${report.problems.join("\n")}\n`);
    process.exitCode = 1;
  }
} catch (error: unknown) {
  const parsed = caughtErrorSchema.safeParse(error);
  const message = parsed.success ? parsed.data.message : "Packaging check failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
