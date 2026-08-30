# Agent notes

Copy `packages/example` when you add a public package. Private `@repo/*` toolchain packages do not copy `example`.

Run `npm run qa` before you push.

## Lint

- Parse untrusted input with Zod at the I/O boundary. Do not use `typeof` to narrow unparsed values.
- Parse functions at an I/O boundary may take `unknown`. Disable `anti-slop/no-unknown-parameters` on that function and give a one-line reason. Do not take `unknown` on other functions.
- Do not add `SAFETY:` comments to justify `as` assertions. Do not use `as`.
- Do not mock modules with `vi.mock` or `jest.mock`.
- Do not use `Record<string, unknown>` or similar dictionary types as a public contract.

## Tests

- Do not write a tautological test: one that passes when the code is correct and also passes when the code is broken.
- Assert on the specific expected outcome. Do not assert only "no error" or "some error" — catching any error and treating it as success hides real bugs.
- When a test depends on timing to exercise a race or an ordering, make the timing deterministic. Do not rely on chance timing to hit the code path under test.

## Prose

Write all prose in simplified technical English. This covers code comments, JSDoc, commit messages, PR descriptions, and chat responses.

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
