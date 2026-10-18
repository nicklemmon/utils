# Workspace package boundaries

The root Oxlint config enables `anti-slop/no-cross-package-internals`.
This rule applies to the direct workspaces in `packages/*`.

Use the package name for imports from another workspace package.
The imported subpath must appear in that package's `exports` map.
Relative and absolute paths into another package are errors, including paths to its index.
Imports within the same package can use private files.

The rule checks static imports, re-exports, import types, and dynamic imports with a static string.
It reads package manifests for each file, so manifest changes apply on the next lint run.
It does not resolve TypeScript path aliases or computed dynamic imports.
The repository has no TypeScript path aliases.

Run `npm run lint` to check the repository.
Run `npm run test --workspace=@repo/anti-slop` to test the plugin.

This rule is a local addition to the vendored plugin.
