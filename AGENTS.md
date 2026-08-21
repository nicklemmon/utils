# Agent notes

Copy `packages/example` when you add a package.

Run `npm run qa` before you push.

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
