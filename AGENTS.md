# Agent notes

This is a library monorepo.

- Public packages use the `@nicklemmon/*` name.
- Private tooling packages use the `@repo/*` name.

Copy `packages/example` when you add a package. Run `npm run ci` before you finish.

## Prose

Write all prose in simplified technical English.

- Use short sentences. Put one idea in each sentence.
- Use common words. Keep necessary technical terms.
- Use the same word for the same thing.
- Use active voice. Use direct commands for instructions (`Do X`. `Do not Y`.).
- Do not use idioms, jokes, or filler.
- Do not write the same fact twice.

This rule applies to JSDoc, README files, comments, changelog text, and commit messages.

## Modules and types

- Use ESM only. Set `"type": "module"`.
- Do not emit CommonJS. Do not add a `require` export condition.
- Use a `.js` suffix on relative imports: `import { x } from "./foo.js"`.
- Use `type`. Do not use `interface`.
- Do not use `as` type assertions. Use a type annotation or `satisfies`.
- You may use `as const` only if oxlint allows it.
- Do not use `any`. Do not use the non-null assertion `!`.
- Put runtime packages such as `zod` in `dependencies`. tsdown must not bundle them.

## JSDoc

Add JSDoc descriptions on public exports. TypeScript is the source of types.

```ts
/**
 * Parse `value` as a non-empty string.
 *
 * @param value - Unknown input to validate.
 * @returns The parsed non-empty string.
 * @throws If `value` is not a non-empty string.
 */
export function parseNonEmptyString(value: unknown): string {}
```

- Write `@param`, `@returns`, and `@throws` descriptions when they add facts that the type signature does not give.
- Do not put types in JSDoc. Do not write `@param {string} value`.
- Do not add JSDoc on tests or config files.

## Tools

- Lint with oxlint in type-aware mode.
- Format with oxfmt. oxfmt sorts imports, sorts `package.json`, and formats JSDoc.
- Build with tsdown. Output is ESM and `.d.ts`. tsdown also runs attw (`esm-only`) and publint.
- Check types with `tsc --noEmit`.
- Test with Vitest in each package.
