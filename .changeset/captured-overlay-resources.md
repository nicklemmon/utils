---
"@nicklemmon/gh-gl": minor
---

Capture overlay content once per rebuild attempt. Preserve exact bytes, executable modes, and symlink targets. Clean up temporary resources when setup or Git work fails. Stream the upstream archive, so rebuilds of upstream trees larger than 100 MB no longer fail.

Breaking behavior changes:

- `gh-gl` now pushes overlay files that a `.gitignore` matches, such as `.env` and `.DS_Store`. Remove secrets and local files from the overlay directory before you upgrade.
- The overlay fingerprint now includes ignored files and ignores Git filters. If the overlay has ignored files, or if a Git filter changed overlay bytes, the first sync after you upgrade rebuilds the GitLab default branch once. That rebuild pushes the newly included files. For other overlays, the fingerprint does not change.
- Upstream files keep their exact GitHub bytes. Upstream `.gitattributes` line ending rules and filters no longer change them. Upstream files that a `.gitignore` matches are no longer dropped.
