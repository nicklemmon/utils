# Agent notes

Copy `packages/example` when you add a public package. Private `@repo/*` toolchain packages do not copy `example`.

For a public package, set `attw` to `{ profile: "esm-only", level: "error" }` and `publint` to `true` in `tsdown.config.ts`.

Run `npm run qa` before you push.

Do not write files in `.changeset/` by hand. Run `npm run changesets:add -- --patch <package> -m "<summary>"` to create a changeset without prompts. Use `--minor` or `--major` for other bumps. A Claude Code hook in `.claude/hooks/` blocks direct writes.

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

Add a short JSDoc description to each named function and method. Do not document inline callbacks. Do not put types in JSDoc. Write `@param`, `@returns`, and `@throws` only when they add facts that the type signature does not give.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
