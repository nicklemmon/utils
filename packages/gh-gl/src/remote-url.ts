/**
 * Decide whether `url` is an HTTPS git remote, as opposed to an SSH remote
 * (`ssh://...` or scp-style `git@host:path`).
 *
 * @param url - A full git remote URL.
 * @returns `true` when `url` uses the `https:` scheme.
 */
export function isHttpsRemote(url: string): boolean {
  return url.startsWith("https://");
}
