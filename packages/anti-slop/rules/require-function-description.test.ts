import { RuleTester } from "oxlint/plugins-dev";

import { requireFunctionDescriptionRule } from "./require-function-description.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingDescription" };

tester.run("anti-slop/require-function-description", requireFunctionDescriptionRule, {
  valid: [
    "/** Parse a package manifest. */\nfunction parseManifest(): void {}",
    "/** Parse a package manifest. */\nexport function parseExportedManifest(): void {}",
    "/** Parse a package manifest. */\nconst parseManifest = (): void => {};",
    "class Manifest { /** Parse the manifest. */ parse(): void {} }",
    "const manifest = { /** Parse the manifest. */ parse(): void {} };",
    "const parseManifest = { /** Parse the manifest. */ parse: (): void => {} };",
    "/** Parse the manifest.\n * @param input Manifest data.\n * @returns The parsed manifest.\n */\nfunction parse(input: string): string { return input; }",
    "items.map((item) => item.name);",
    "items.map(function (item) { return item.name; });",
    "/** Parse the manifest. */\nconst callback = function (): void {};",
  ],
  invalid: [
    { code: "function parseManifest(): void {}", errors: [error] },
    { code: "const parseManifest = (): void => {};", errors: [error] },
    { code: "class Manifest { parse(): void {} }", errors: [error] },
    { code: "const manifest = { parse(): void {} };", errors: [error] },
    { code: "const parseManifest = { parse: (): void => {} };", errors: [error] },
    { code: "const callback = function named(): void {};", errors: [error] },
    {
      code: "/** @param input Manifest data. */\nfunction parse(input: string): void {}",
      errors: [error],
    },
    {
      code: "/** Parse input.\n * @param {string} input Input data.\n */\nfunction parse(input: string): void {}",
      errors: [{ messageId: "redundantType" }],
    },
    {
      code: "/** Parse input.\n * @arg {string} input Input data.\n */\nfunction parse(input: string): void {}",
      errors: [{ messageId: "redundantType" }],
    },
    {
      code: "/** Parse input.\n * @argument {string} input Input data.\n */\nfunction parse(input: string): void {}",
      errors: [{ messageId: "redundantType" }],
    },
    {
      code: "/** Parse input.\n * @return {string} The parsed value.\n */\nfunction parse(input: string): string { return input; }",
      errors: [{ messageId: "redundantType" }],
    },
    { code: "interface Parser { parse(input: string): string; }", errors: [error] },
  ],
});
