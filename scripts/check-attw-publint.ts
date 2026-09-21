import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const manifestSchema = z.object({
  private: z.boolean().optional(),
});

function stripLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function hasField(source: string, fieldName: string): boolean {
  return new RegExp(`^\\s*${fieldName}\\s*:`, "mu").test(source);
}

function isPrivatePackage(manifestText: string): boolean {
  const parsed: unknown = JSON.parse(manifestText);
  return manifestSchema.parse(parsed).private === true;
}

function collectProblems(directory: string): readonly string[] {
  const problems: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageDirectory = path.join(directory, entry.name);
    const manifestPath = path.join(packageDirectory, "package.json");
    if (!existsSync(manifestPath)) continue;

    const configPath = path.join(packageDirectory, "tsdown.config.ts");
    if (!existsSync(configPath)) {
      if (!isPrivatePackage(readFileSync(manifestPath, "utf8"))) {
        problems.push(`${entry.name}: add tsdown.config.ts and set attw and publint.`);
      }
      continue;
    }

    const source = stripLineComments(readFileSync(configPath, "utf8"));
    if (!hasField(source, "attw")) {
      problems.push(`${entry.name}: set attw in tsdown.config.ts.`);
    }
    if (!hasField(source, "publint")) {
      problems.push(`${entry.name}: set publint in tsdown.config.ts.`);
    }
  }

  return problems;
}

const found = collectProblems(path.join(import.meta.dirname, "..", "packages"));
if (found.length > 0) {
  process.stderr.write(`${found.join("\n")}\n`);
  process.exitCode = 1;
}
