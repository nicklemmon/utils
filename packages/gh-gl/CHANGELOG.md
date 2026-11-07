# @nicklemmon/gh-gl

## 0.1.1

### Patch Changes

- 16c77f3: Capture overlay content once per rebuild attempt. Preserve ignored files, exact bytes, executable modes, and symlink targets. Clean up temporary resources when setup or Git work fails.
- 16c77f3: Stream the upstream archive when rebuilding. Rebuilds of upstream trees larger than 100 MB no longer fail.
- 7d37d99: Update execa from ^10.0.1 to ^10.1.0 and varlock from ^1.19.0 to ^1.22.0.

## 0.1.0

### Minor Changes

- 331f3e1: Add the `gh-gl` CLI. It syncs a GitHub repo's default branch into a downstream GitLab repo, applies an overlay for GitLab-only files, and can merge that result into prototype branches.
