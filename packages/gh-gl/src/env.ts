import { isHttpsRemote } from "./remote-url.js";

/** Inputs needed to decide whether GITHUB_TOKEN/GITLAB_TOKEN are required. */
export type TokenValidationInput = {
  githubUrl: string;
  gitlabUrl: string;
  githubToken: string | undefined;
  gitlabToken: string | undefined;
};

/**
 * Check that every HTTPS remote has its matching token set. An SSH remote
 * never requires a token, since it authenticates via the ambient SSH agent.
 *
 * @param input - The remote URLs and the tokens currently available.
 * @returns One error message per missing required token. Empty when valid.
 */
export function validateTokens(input: Readonly<TokenValidationInput>): Array<string> {
  const errors: Array<string> = [];

  if (isHttpsRemote(input.githubUrl) && input.githubToken === undefined) {
    errors.push("GITHUB_TOKEN is required when --github-url is HTTPS");
  }

  if (isHttpsRemote(input.gitlabUrl) && input.gitlabToken === undefined) {
    errors.push("GITLAB_TOKEN is required when --gitlab-url is HTTPS");
  }

  return errors;
}
