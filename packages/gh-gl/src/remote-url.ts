/**
 * Decide whether `url` is an HTTPS git remote, as opposed to an SSH remote (`ssh://...` or
 * scp-style `git@host:path`).
 *
 * @param url - Candidate remote URL from a CLI flag or sync option.
 * @returns Whether `url` uses the `https:` scheme.
 */
export function isHttpsRemote(url: string): boolean {
  return url.startsWith("https://");
}

/**
 * Decide whether `url` is a full git remote URL. Rejects `owner/repo` shorthand so self-hosted
 * GitLab hosts stay unambiguous.
 *
 * Accepts `https://...`, `ssh://...`, and scp-style `user@host:path` forms.
 *
 * @param url - Candidate remote URL from a CLI flag.
 * @returns Whether `url` is a full remote URL rather than shorthand.
 */
export function isFullGitRemoteUrl(url: string): boolean {
  if (url.includes("://")) {
    return true;
  }

  // scp-style: git@host:path — must have user@host and a path after the first colon.
  return /^[^/@]+@[^:]+:\S+$/u.test(url);
}
