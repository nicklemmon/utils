import { readFileSync, writeFileSync } from "node:fs";

const runnerDirectory = new URL(
  "../node_modules/@stryker-mutator/vitest-runner/dist/src/",
  import.meta.url,
);
const runnerFiles = [
  new URL("test-helpers.js", runnerDirectory),
  new URL("stryker-setup.js", runnerDirectory),
];

for (const filePath of runnerFiles) {
  const source = readFileSync(filePath, "utf8");
  const before = "join(' ').trim();";
  const after = "join(' > ').trim();";
  const beforeCount = source.split(before).length - 1;
  const afterCount = source.split(after).length - 1;

  if (beforeCount === 0 && afterCount === 1) {
    continue;
  }

  if (beforeCount !== 1 || afterCount !== 0) {
    throw new Error(`Expected one unpatched separator in ${filePath.href}`);
  }

  writeFileSync(filePath, source.replace(before, after));
}
