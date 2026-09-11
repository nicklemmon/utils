# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to version packages and write changelogs.

```bash
npm run changesets:add
```

After changesets land on `main`, the Release workflow opens a Version Packages PR. Merging that PR bumps versions and changelogs. A separate publish job then waits for approval in the `npm-publish` GitHub Environment before publishing with Trusted Publishing (OIDC).

For a local version bump without publishing:

```bash
npm run changesets:version
```

For a local publish (bootstrap or debug only; prefer CI after Trusted Publishing is configured):

```bash
npm run changesets:publish
```
