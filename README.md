# utils

Reusable TypeScript utilities published as ESM-only packages.

## Requirements

- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`
- npm 11 (see `packageManager` in the root `package.json`)

## Layout

- `packages/typescript-config` — private shared TypeScript config (`@repo/typescript-config`)
- `packages/anti-slop` — private Oxlint anti-slop plugin (`@repo/anti-slop`)
- `packages/example` — seed package that proves the toolchain (`@nicklemmon/example`)
- Public packages use the `@nicklemmon/*` scope and live in `packages/<name>`

There is no `apps/` directory. This is a library monorepo.

## Scripts

| Command                    | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `npm run build`            | Bundle each package with tsdown (ESM + `.d.ts`, attw, publint) |
| `npm run check-types`      | `tsc --noEmit` per package                                     |
| `npm run test`             | Vitest per package                                             |
| `npm run test:watch`       | Vitest per package in watch mode                               |
| `npm run dev`              | Run each package's `dev` script                                |
| `npm run lint`             | Oxlint (type-aware)                                            |
| `npm run lint:fix`         | Oxlint with autofix                                            |
| `npm run format`           | Oxfmt check                                                    |
| `npm run format:fix`       | Oxfmt write                                                    |
| `npm run quality`          | Lint and format (cached via turbo)                             |
| `npm run qa`               | Build, typecheck, test, lint, format, and `npm audit`          |
| `npm run audit`            | Fail on high or critical `npm audit` findings                  |
| `npm run changeset`        | Add a changeset for a version bump                             |
| `npm run version-packages` | Apply changesets locally (does not publish)                    |

Run `turbo run lint` / `turbo run format` when you want those root tasks cached.

## Adding a package

1. Create `packages/<name>` with `"name": "@nicklemmon/<name>"` and `"type": "module"`.
2. Extend `@repo/typescript-config/library.json`.
3. Add a `tsdown.config.ts` (ESM only, `attw.profile: "esm-only"`) and a `vitest.config.ts`.
4. Implement `build`, `check-types`, `test`, and `dev` scripts to match `@nicklemmon/example`.
5. Put runtime libraries such as `zod` in `dependencies` so tsdown externalizes them.

Packages are ESM-only. Coding conventions (JSDoc, `type` vs `interface`, no `as`) are in [AGENTS.md](./AGENTS.md).

## Versioning

This repo uses [Changesets](https://github.com/changesets/changesets) for version and changelog files. Publishing to npm is not automated yet.
