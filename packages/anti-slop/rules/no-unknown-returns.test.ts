import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownReturnsRule } from "./no-unknown-returns.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownReturn" };

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
  valid: [
    "type Value = string; switch (((): Value => input)()) { case '': type Value = unknown; break; }",
    "type Local = unknown; const C = class Local { method(): Local { return this; } };",
    "type ImportedValue = unknown;",
    "function parse(): ImportedValue { return input; }",
    "function parse(): User { return user; }",
    "function infer() { return input; }",
    "function generic<Value>(): Value { return value; }",
    "type Value = unknown; function generic<Value>(): Value { return value; }",
    "type Key = unknown; type Mapped<Input> = { [Key in keyof Input]: () => Key };",
    "type Item = unknown; type Unpacked<Input> = Input extends Promise<infer Item> ? () => Item : never;",
    "function cause(): { cause: unknown } { return { cause: input }; }",
    "type Result = { value: unknown }; function load(): Result { return result; }",
    "function load(): Promise<User> { return promise; }",
    "type Promise<T> = { value: T }; function load(): Promise<unknown> { return input; }",
    "type Value = unknown; function outer() { type Value = string; function inner(): Value { return value; } }",
    "type First = Second; type Second = First; function load(): First { return value; }",
    "type Value = unknown; function load<Value>(): Promise<Value> { return promise; }",
    "function load<Promise>(): Promise<unknown> { return promise; }",
    "interface Promise<T> { value: T } function load(): Promise<unknown> { return promise; }",
    "class PromiseLike<T> { value!: T } function load(): PromiseLike<unknown> { return promise; }",
    "import { Promise } from './custom.js'; function load(): Promise<unknown> { return promise; }",
    "type Value = unknown; function outer() { type Value = string; function load(): Value { return value; } }",
    "type Value = unknown; function outer() { enum Value { A } function load(): Value { return Value.A; } }",
    "type Value = unknown; namespace Other { export type Value = string; } namespace N { import Value = Other.Value; export function load(): Value { return value; } }",
    "type Value = string; function outer() { switch (input) { case 0: type Value = unknown; break; } function load(): Value { return value; } }",
    "type Value = unknown; function outer() { switch (input) { case 0: type Value = string; function first(): Value { return value; } break; case 1: function second(): Value { return value; } } }",
  ],
  invalid: [
    {
      code: "type Value = unknown; switch (((): Value => input)()) { case '': type Value = string; break; }",
      errors: [error],
    },
    {
      code: "type Value = unknown; type Result = Value; function load<Value>(): Result { return input; }",
      errors: [error],
    },
    {
      code: "type Later = First; export type First = unknown; function load(): Later { return input; }",
      errors: [error],
    },
    {
      code: "type First = Second; type Second = unknown; function load(): First { return input; }",
      errors: [error],
    },
    {
      code: "function outer<Value>() { { type Value = unknown; function inner(): Value { return input; } } }",
      errors: [error],
    },
    { code: "function load(): unknown { return input; }", errors: [error] },
    { code: "const load = (): unknown => input;", errors: [error] },
    { code: "type Loader = () => unknown;", errors: [error] },
    { code: "interface Loader { load(): unknown }", errors: [error] },
    { code: "declare function load(): unknown;", errors: [error] },
    { code: "function load(): string | unknown { return input; }", errors: [error] },
    { code: "function load(): Promise<unknown> { return promise; }", errors: [error] },
    {
      code: "type UnknownValue = unknown; function load(): UnknownValue { return input; }",
      errors: [error],
    },
    {
      code: "type Item = unknown; type Fallback<Input> = Input extends infer Item ? string : () => Item;",
      errors: [error],
    },
    {
      code: "type Value = unknown; function outer() { switch (input) { case 0: type Value = string; break; } function load(): Value { return value; } }",
      errors: [error],
    },
    {
      code: "function outer() { type Value = unknown; switch (input) { case 0: function inner(): Value { return value; } } }",
      errors: [error],
    },
  ],
});
