# Agent notes

Copy `packages/example` when you add a public package. Private `@repo/*` toolchain packages do not copy `example`.

Run `npm run qa` before you push.

## Lint

- Parse untrusted input with Zod at the I/O boundary. Do not use `typeof` to narrow unparsed values.
- Parse functions at an I/O boundary may take `unknown`. Disable `anti-slop/no-unknown-parameters` on that function and give a one-line reason. Do not take `unknown` on other functions.
- Do not add `SAFETY:` comments to justify `as` assertions. Do not use `as`.
- Do not mock modules with `vi.mock` or `jest.mock`.
- Do not use `Record<string, unknown>` or similar dictionary types as a public contract.

## Prose

Write all prose in simplified technical English.

- Use short sentences. Put one idea in each sentence.
- Use common words. Keep necessary technical terms.
- Use the same word for the same thing.
- Use active voice. Use direct commands for instructions (`Do X`. `Do not Y`.).
- Do not use idioms, jokes, or filler.
- Do not write the same fact twice.

## Types

- Use `type`. Do not use `interface`.
- Do not use `as` type assertions. Use a type annotation or `satisfies`. You may use `as const`.

## JSDoc

Add JSDoc descriptions on public exports. Do not put types in JSDoc. Write `@param`, `@returns`, and `@throws` only when they add facts that the type signature does not give.
