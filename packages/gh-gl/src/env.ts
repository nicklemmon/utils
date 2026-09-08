import { ENV } from "varlock/env";

import { isHttpsRemote } from "./remote-url.js";

declare module "varlock/env" {
  // Augments varlock's empty TypedEnvSchema with the keys from `.env.schema`.
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation must use interface merging.
  interface TypedEnvSchema {
    readonly GITHUB_TOKEN?: string;
    readonly GITLAB_TOKEN?: string;
  }
}

/** Inputs needed to decide whether GITHUB_TOKEN/GITLAB_TOKEN are required. */
export type TokenValidationInput = {
  githubUrl: string;
  gitlabUrl: string;
  githubToken: string | undefined;
  gitlabToken: string | undefined;
};

/** Tokens read from varlock for one `gh-gl` run. */
export type SyncTokens = {
  githubToken: string | undefined;
  gitlabToken: string | undefined;
};

// Missing and empty tokens are the same: varlock yields `undefined` when unset and `""` when empty.
function isUsableToken(token: string | undefined): boolean {
  return token !== undefined && token !== "";
}

/**
 * Read `GITHUB_TOKEN` and `GITLAB_TOKEN` from varlock's `ENV` proxy.
 *
 * Call this only under `varlock run`, which initializes that proxy.
 *
 * @returns The two tokens, with empty strings normalized to `undefined`.
 */
export function readSyncTokens(): SyncTokens {
  const githubToken = ENV.GITHUB_TOKEN;
  const gitlabToken = ENV.GITLAB_TOKEN;

  return {
    githubToken: isUsableToken(githubToken) ? githubToken : undefined,
    gitlabToken: isUsableToken(gitlabToken) ? gitlabToken : undefined,
  };
}

/**
 * Check that every HTTPS remote has its matching token set. An SSH remote never requires a token,
 * since it authenticates via the ambient SSH agent.
 *
 * @param input - Remote URLs plus the tokens currently available from the environment.
 * @returns One error message per missing required token, or an empty list when every required token
 *   is present.
 */
export function validateTokens(input: Readonly<TokenValidationInput>): Array<string> {
  const errors: Array<string> = [];

  if (isHttpsRemote(input.githubUrl) && !isUsableToken(input.githubToken)) {
    errors.push("GITHUB_TOKEN is required when --github-url is HTTPS");
  }

  if (isHttpsRemote(input.gitlabUrl) && !isUsableToken(input.gitlabToken)) {
    errors.push("GITLAB_TOKEN is required when --gitlab-url is HTTPS");
  }

  return errors;
}
