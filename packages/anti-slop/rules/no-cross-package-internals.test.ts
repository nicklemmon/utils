import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import { afterAll } from "vitest";

import { noCrossPackageInternalsRule } from "./no-cross-package-internals.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "anti-slop-boundaries-"));
/** Create a workspace package fixture. */
const createPackage = (folder: string, manifest: string) => {
  const packageRoot = path.join(root, "packages", folder);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), manifest);
  return packageRoot;
};
writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
const alpha = createPackage(
  "alpha",
  JSON.stringify({ name: "@repo/alpha", exports: { ".": "./src/index.ts" } }),
);
const beta = createPackage(
  "beta",
  JSON.stringify({
    name: "@repo/beta",
    exports: {
      ".": { import: "./index.js", require: "./index.cjs" },
      "./public/*": "./public/*.js",
      "./public/private/*": null,
      "./hidden": { import: null, require: null },
    },
  }),
);
createPackage(
  "conditional-null",
  JSON.stringify({
    name: "@repo/conditional-null",
    exports: { import: null, require: null },
  }),
);
const closed = createPackage("closed", JSON.stringify({ name: "@repo/closed" }));
mkdirSync(path.join(beta, "public"), { recursive: true });
symlinkSync(beta, path.join(alpha, "node_modules-beta"), "dir");
/** Build a path inside a workspace package fixture. */
const filename = (packageRoot: string, name = "entry.ts") => path.join(packageRoot, name);
const error = { messageId: "crossPackage" };
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
tester.run("anti-slop/no-cross-package-internals", noCrossPackageInternalsRule, {
  valid: [
    { code: "import { x } from './internal';", filename: filename(alpha) },
    { code: "import { x } from '@repo/alpha/private';", filename: filename(alpha) },
    { code: "import { x } from '@repo/beta';", filename: filename(alpha) },
    { code: "import { x } from '@repo/beta/public/item';", filename: filename(alpha) },
    { code: "import { x } from '@repo/beta/public/item?raw#part';", filename: filename(alpha) },
    { code: "export { x } from '@repo/beta';", filename: filename(alpha) },
    { code: "export * from '@repo/beta';", filename: filename(alpha) },
    { code: "const x = import('@repo/beta');", filename: filename(alpha) },
    { code: "const x = import(`@repo/beta`);", filename: filename(alpha) },
    { code: "type X = import('@repo/beta').X;", filename: filename(alpha) },
    { code: "import { x } from './internal';", filename: filename(beta) },
    { code: "import { x } from 'external-library';", filename: filename(alpha) },
  ],
  invalid: [
    { code: "import { x } from '../beta/index';", filename: filename(alpha), errors: [error] },
    {
      code: "import { x } from '@repo/beta/internal';",
      filename: filename(alpha),
      errors: [error],
    },
    {
      code: "import { x } from '@repo/beta/public/private/item';",
      filename: filename(alpha),
      errors: [error],
    },
    { code: "import { x } from '@repo/beta/hidden';", filename: filename(alpha), errors: [error] },
    {
      code: "import { x } from '../conditional-null';",
      filename: filename(alpha),
      errors: [error],
    },
    {
      code: "import { x } from '@repo/conditional-null';",
      filename: filename(alpha),
      errors: [error],
    },
    { code: "import { x } from '@repo/beta/private';", filename: filename(alpha), errors: [error] },
    { code: "export { x } from '../beta/index';", filename: filename(alpha), errors: [error] },
    { code: "export * from '../beta/index';", filename: filename(alpha), errors: [error] },
    { code: "const x = import('../beta/index');", filename: filename(alpha), errors: [error] },
    { code: "const x = import(`../beta/index`);", filename: filename(alpha), errors: [error] },
    { code: "type X = import('../beta/index').X;", filename: filename(alpha), errors: [error] },
    { code: "import { x } from '@repo/closed';", filename: filename(alpha), errors: [error] },
    {
      code: `import { x } from '${pathToFileURL(path.join(beta, "index.js")).href}';`,
      filename: filename(alpha),
      errors: [error],
    },
    {
      code: "import { x } from './node_modules-beta/index.js';",
      filename: filename(alpha),
      errors: [error],
    },
  ],
});

void closed;
