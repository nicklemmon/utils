# Domain terms

- **Sync run**: one call to `gh-gl sync`. It rebuilds the default branch or merges into a prototype branch.
- **Overlay**: a local directory of GitLab files that replace matching upstream paths.
- **Overlay capture**: the files, modes, and symlink targets stored as a Git tree for one rebuild attempt.
- **Overlay fingerprint**: the tree hash of an overlay capture. Sync trailers use it to detect changes.
- **Scratch repo**: a temporary Git repository owned by one operation or rebuild attempt.
- **Askpass helper**: a temporary executable that supplies one remote token to Git. It stays alive for its sync run.
- **Unknown alias resolution**: following local type aliases in their declaration scope to check a lint rule's unknown-type policy.
