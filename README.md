# utils

Reusable TypeScript utilities published as ESM-only packages.

## Layout

Public packages use the `@nicklemmon/*` scope and live in `packages/<name>`

## Scripts

| Command                      | What it does                                                   |
| ---------------------------- | -------------------------------------------------------------- |
| `npm run build`              | Bundle each package with tsdown (ESM + `.d.ts`, attw, publint) |
| `npm run check-types`        | `tsc --noEmit` per package                                     |
| `npm run test`               | Vitest per package                                             |
| `npm run test:watch`         | Vitest per package in watch mode                               |
| `npm run dev`                | Run each package's `dev` script                                |
| `npm run lint`               | Oxlint (type-aware)                                            |
| `npm run lint:fix`           | Oxlint with autofix                                            |
| `npm run format`             | Oxfmt check                                                    |
| `npm run format:fix`         | Oxfmt write                                                    |
| `npm run check`              | Lint and format (cached via turbo)                             |
| `npm run qa`                 | Build, typecheck, test, lint, format, and `npm audit`          |
| `npm run audit`              | Fail on high or critical `npm audit` findings                  |
| `npm run changesets:add`     | Add a changeset for a version bump                             |
| `npm run changesets:version` | Apply changesets locally (does not publish)                    |
| `npm run changesets:publish` | Build packages, then `changeset publish` (CI / bootstrap)      |

Run `turbo run lint` / `turbo run format` when you want those root tasks cached.

## Adding a package

1. Create `packages/<name>` with `"name": "@nicklemmon/<name>"` and `"type": "module"`.
2. Extend `@repo/typescript-config/library.json`.
3. Add a `tsdown.config.ts` (ESM only, `attw.profile: "esm-only"`) and a `vitest.config.ts`.
4. Implement `build`, `check-types`, `test`, and `dev` scripts to match `@nicklemmon/example`.
5. Put runtime libraries such as `zod` in `dependencies` so tsdown externalizes them.

Packages are ESM-only. Coding conventions (JSDoc, `type` vs `interface`, no `as`) are in [AGENTS.md](./AGENTS.md).

## Versioning and publishing

This repo uses [Changesets](https://github.com/changesets/changesets) for versions and changelogs.

1. On a feature PR, run `npm run changesets:add` and commit the file under `.changeset/`.
2. After merge to `main`, the Release workflow opens or updates a **Version Packages** PR (version bumps + changelogs).
3. Merge that PR. The Release workflow starts a **publish** job in the `npm-publish` GitHub Environment.
4. Approve that deployment when GitHub asks. Only then does CI publish to npm (OIDC), create git tags, and create GitHub Releases.

CI publishes with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC). There is no long-lived `NPM_TOKEN` in GitHub secrets. Provenance attestations are attached automatically. The Trusted Publisher on npm should use Environment name `npm-publish` so it matches the GitHub Environment.

`@nicklemmon/example` and `@repo/*` packages stay private and are not published.
