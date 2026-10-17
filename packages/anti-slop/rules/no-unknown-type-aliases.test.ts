import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownAlias" };

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
  valid: [
    "type User = { readonly id: string };",
    "type Alias = string; type UserId = Alias;",
    "type First = Second; type Second = First;",
    "type Mixed = string | unknown;",
    "type Wrapped = Promise<unknown>;",
    "type Value = string; function outer() { type Value = string; type Local = Value; }",
  ],
  invalid: [
    {
      code: "type Value = unknown; type Alias<Value> = Value;",
      errors: [{ messageId: "unknownAlias", line: 1, column: 5 }],
    },
    { code: "type Alias = unknown;", errors: [error] },
    { code: "type Alias<Input> = unknown;", errors: [error] },
    {
      code: "type Value = unknown; type Alias<Input> = Value;",
      errors: [error, error],
    },
    { code: "type Current = unknown;", errors: [error] },
    { code: "type UnknownValue = unknown; type Alias = UnknownValue;", errors: [error, error] },
    {
      code: "type Later = First; export type First = unknown;",
      errors: [
        { messageId: "unknownAlias", line: 1, column: 5 },
        { messageId: "unknownAlias", line: 1, column: 32 },
      ],
    },
    {
      code: "function outer() { type Value = unknown; type Alias = Value; }",
      errors: [
        { messageId: "unknownAlias", line: 1, column: 24 },
        { messageId: "unknownAlias", line: 1, column: 46 },
      ],
    },
  ],
});
