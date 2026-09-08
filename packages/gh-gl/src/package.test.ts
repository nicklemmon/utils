import { execa } from "execa";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const PackedPackageSchema = z.object({
  files: z.array(z.object({ path: z.string() })),
});
const PackOutputSchema = z.tuple([PackedPackageSchema]).rest(PackedPackageSchema);

describe("published package", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("includes the Varlock schema used by the CLI shim", async () => {
    const packageDir = path.resolve(import.meta.dirname, "..");
    const npmCacheDir = mkdtempSync(path.join(tmpdir(), "gh-gl-npm-cache-"));

    cleanups.push(() => {
      rmSync(npmCacheDir, { recursive: true, force: true });
    });
    const { stdout } = await execa("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageDir,
      env: { npm_config_cache: npmCacheDir },
    });
    const packOutput: unknown = JSON.parse(stdout);
    const [packedPackage] = PackOutputSchema.parse(packOutput);

    expect(packedPackage.files.map((file) => file.path)).toContain(".env.schema");
  });
});
