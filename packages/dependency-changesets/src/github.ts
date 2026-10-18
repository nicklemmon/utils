import { z } from "zod";

import type { ChangesetServices } from "./machine.ts";
import type { ChangesetPlan, ChangesetSource, PackageChange } from "./plan.ts";

const shaSchema = z.string().regex(/^[a-f\d]{40}$/u);
const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);
const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.literal("open"),
  user: z.object({ login: z.literal("dependabot[bot]") }),
  base: z.object({
    ref: z.string(),
    sha: shaSchema,
    repo: z.object({ full_name: repositorySchema }),
  }),
  head: z.object({
    ref: z.string().startsWith("dependabot/"),
    sha: shaSchema,
    repo: z.object({ full_name: repositorySchema }),
  }),
});
const treeSchema = z.object({
  sha: shaSchema,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string(), sha: shaSchema })),
});
const blobSchema = z.object({ encoding: z.literal("base64"), content: z.string() });
const commitSchema = z.object({ sha: shaSchema, tree: z.object({ sha: shaSchema }) });
const mutationSchema = z.object({
  data: z
    .object({ createCommitOnBranch: z.object({ commit: z.object({ oid: shaSchema }) }).nullable() })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
const comparisonSchema = z.object({ merge_base_commit: z.object({ sha: shaSchema }) });
const configSchema = z.object({ ignore: z.array(z.string()).default([]) });
const rootSchema = z.object({ workspaces: z.tuple([z.literal("packages/*")]) });

type Tree = z.infer<typeof treeSchema>;
type Pull = z.infer<typeof pullSchema>;
type Mutation = Readonly<{
  query: string;
  variables: Readonly<{
    input: Readonly<{
      branch: Readonly<{ repositoryNameWithOwner: string; branchName: string }>;
      expectedHeadOid: string;
      message: Readonly<{ headline: string }>;
      fileChanges: Readonly<{
        additions: readonly Readonly<{ path: string; contents: string }>[];
        deletions: readonly Readonly<{ path: string }>[];
      }>;
    }>;
  }>;
}>;

/** Settings for a GitHub changeset run. Requests use only api.github.com. */
export type GitHubOptions = Readonly<{
  repository: string;
  number: number;
  token: string;
  expectedHead?: string | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RequestInit is the fetch library contract.
  request?: (url: string, init: RequestInit) => Promise<Response>;
}>;

/**
 * Create GitHub effects without checking out or running PR code.
 *
 * @param options - GitHub credentials and the PR number. The token is never logged.
 * @returns Effects that read immutable Git objects and publish only on the captured head.
 */
export function githubServices(options: GitHubOptions): ChangesetServices {
  const repository = repositorySchema.parse(options.repository);
  const number = z.number().int().positive().parse(options.number);
  const request = options.request ?? fetch;
  const prefix = `https://api.github.com/repos/${repository}`;

  /** Send one GitHub API request and validate its response. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Zod schema methods use mutable library types.
  async function api<T>(path: string, schema: z.ZodType<T>, payload?: Mutation): Promise<T> {
    const init: RequestInit = {
      method: payload ? "POST" : "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    };
    if (payload) {
      init.body = JSON.stringify(payload);
    }
    const response = await request(
      path === "/graphql" ? "https://api.github.com/graphql" : `${prefix}${path}`,
      init,
    );
    if (!response.ok) {
      throw new Error(
        `GitHub ${response.status} for ${path}. Rerun after checking the PR and permissions.`,
      );
    }
    return schema.parse(await response.json());
  }

  /** Read and validate the pull request for this run. */
  async function readPull(): Promise<Pull> {
    const pull = await api(`/pulls/${number}`, pullSchema);
    if (
      pull.number !== number ||
      pull.head.repo.full_name !== repository ||
      pull.base.repo.full_name !== repository ||
      pull.base.ref !== "main"
    ) {
      throw new Error("Only same-repository Dependabot PRs targeting main are supported");
    }
    if (options.expectedHead !== undefined && pull.head.sha !== options.expectedHead) {
      throw new Error(
        "PR head no longer matches this workflow run. Run checks on the current head.",
      );
    }
    return pull;
  }

  /** Read a commit tree by reference. */
  async function readTree(ref: string): Promise<Tree> {
    const commit = await api(`/git/commits/${ref}`, commitSchema);
    return api(`/git/trees/${commit.tree.sha}?recursive=1`, treeSchema);
  }

  /** Read a regular file from a Git tree. */
  async function readFile(
    tree: Readonly<{ tree: readonly Readonly<Tree["tree"][number]>[] }>,
    path: string,
  ): Promise<string> {
    const entry = tree.tree.find((item) => item.path === path);
    if (!entry || entry.type !== "blob" || entry.mode !== "100644") {
      throw new Error(`Expected a regular file: ${path}`);
    }
    const blob = await api(`/git/blobs/${entry.sha}`, blobSchema);
    return Buffer.from(blob.content, "base64").toString("utf8");
  }

  /** Load PR metadata and package manifests from Git objects. */
  async function load(): Promise<ChangesetSource> {
    const pull = await readPull();
    const comparison = await api(`/compare/${pull.base.sha}...${pull.head.sha}`, comparisonSchema);
    const [baseTree, headTree, trustedTree] = await Promise.all([
      readTree(comparison.merge_base_commit.sha),
      readTree(pull.head.sha),
      readTree(pull.base.sha),
    ]);
    rootSchema.parse(JSON.parse(await readFile(trustedTree, "package.json")));
    const config = configSchema.parse(
      JSON.parse(await readFile(trustedTree, ".changeset/config.json")),
    );
    const paths = new Set(
      [...baseTree.tree, ...headTree.tree]
        .filter((item) => /^packages\/[^/]+\/package\.json$/u.test(item.path))
        .map((item) => item.path),
    );
    const packages: PackageChange[] = [];
    const changes = await Promise.all(
      [...paths].toSorted().map(async (path): Promise<PackageChange | undefined> => {
        const before = baseTree.tree.find((item) => item.path === path);
        const after = headTree.tree.find((item) => item.path === path);
        if (before && after && before.sha === after.sha) {
          return undefined;
        }
        const [oldFile, newFile] = await Promise.all([
          readFile(baseTree, path),
          readFile(headTree, path),
        ]);
        return { path, before: oldFile, after: newFile };
      }),
    );
    for (const change of changes) {
      if (change) {
        packages.push(change);
      }
    }
    const path = `.changeset/dependabot-${number}.md`;
    const existing = headTree.tree.some((item) => item.path === path)
      ? await readFile(headTree, path)
      : undefined;
    return {
      number,
      head: pull.head.sha,
      branch: pull.head.ref,
      ignored: config.ignore,
      packages,
      existing,
    };
  }

  /** Confirm the pull request head still matches the captured source. */
  async function verify(source: ChangesetSource): Promise<void> {
    const pull = await readPull();
    if (pull.head.sha !== source.head || pull.head.ref !== source.branch) {
      throw new Error("PR head changed. Rerun to generate a changeset for the new head.");
    }
  }

  /** Commit the changeset update to the pull request branch. */
  async function publish(source: ChangesetSource, plan: ChangesetPlan): Promise<void> {
    const result = await api("/graphql", mutationSchema, {
      query:
        "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repository, branchName: source.branch },
          expectedHeadOid: source.head,
          message: { headline: `chore: update dependency changeset for #${number}` },
          fileChanges: {
            additions:
              plan.content === null
                ? []
                : [{ path: plan.path, contents: Buffer.from(plan.content).toString("base64") }],
            deletions: plan.content === null ? [{ path: plan.path }] : [],
          },
        },
      },
    });
    if (result.errors !== undefined && result.errors.length > 0) {
      throw new Error(
        `GitHub refused changeset commit: ${result.errors.map((error) => error.message).join("; ")}`,
      );
    }
    if (
      result.data === undefined ||
      result.data === null ||
      result.data.createCommitOnBranch === null
    ) {
      throw new Error("GitHub did not return a changeset commit. Check the PR before retrying.");
    }
  }

  return { load, verify, publish };
}
