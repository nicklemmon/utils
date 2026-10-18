import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GitHubOptions } from "./github.ts";

import { githubServices } from "./github.ts";
import { runChangesets } from "./machine.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const baseTree = "c".repeat(40);
const headTree = "d".repeat(40);
const createdCommit = "f".repeat(40);
const prefix = "https://api.github.com/repos/owner/repo";

type Call = Readonly<{ path: string; method: string; body: string | undefined }>;
type Fixture = {
  options: GitHubOptions;
  responses: Map<string, Response>;
  calls: Call[];
};

/** Build a pull request response for GitHub API tests. */
function pull(sha: string = head): Response {
  return Response.json({
    number: 40,
    state: "open",
    user: { login: "dependabot[bot]" },
    base: { ref: "main", sha: base, repo: { full_name: "owner/repo" } },
    head: { ref: "dependabot/npm/update", sha, repo: { full_name: "owner/repo" } },
  });
}

/** Build GitHub request and response fixtures for integration tests. */
function fixture(): Fixture {
  const calls: Call[] = [];
  const responses = new Map<string, Response>([
    ["/pulls/40", pull()],
    [`/compare/${base}...${head}`, Response.json({ merge_base_commit: { sha: base } })],
    [`/git/commits/${base}`, Response.json({ sha: base, tree: { sha: baseTree } })],
    [`/git/commits/${head}`, Response.json({ sha: head, tree: { sha: headTree } })],
    [
      "/graphql",
      Response.json({ data: { createCommitOnBranch: { commit: { oid: createdCommit } } } }),
    ],
  ]);
  const files = [
    { path: "package.json", sha: "1".repeat(40), content: '{"workspaces":["packages/*"]}' },
    { path: ".changeset/config.json", sha: "2".repeat(40), content: '{"ignore":[]}' },
    {
      path: "packages/public/package.json",
      sha: "3".repeat(40),
      content: '{"name":"public","dependencies":{"execa":"^10.0.1"}}',
    },
  ] as const;
  const updated = {
    path: "packages/public/package.json",
    sha: "4".repeat(40),
    content: '{"name":"public","dependencies":{"execa":"^10.1.0"}}',
  } as const;
  for (const file of [...files, updated]) {
    responses.set(
      `/git/blobs/${file.sha}`,
      Response.json({ encoding: "base64", content: Buffer.from(file.content).toString("base64") }),
    );
  }
  responses.set(
    `/git/trees/${baseTree}?recursive=1`,
    Response.json({
      sha: baseTree,
      truncated: false,
      tree: files.map((file) => ({ path: file.path, sha: file.sha, type: "blob", mode: "100644" })),
    }),
  );
  responses.set(
    `/git/trees/${headTree}?recursive=1`,
    Response.json({
      sha: headTree,
      truncated: false,
      tree: [files[0], files[1], updated].map((file) => ({
        path: file.path,
        sha: file.sha,
        type: "blob",
        mode: "100644",
      })),
    }),
  );
  /** Record and return fixture responses for GitHub calls. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RequestInit is the injected fetch library contract.
  const request: NonNullable<GitHubOptions["request"]> = async (input, init) => {
    const path =
      input === "https://api.github.com/graphql" ? "/graphql" : input.slice(prefix.length);
    const body = z.string().optional().parse(init.body);
    calls.push({ path, method: init.method ?? "GET", body });
    const response = responses.get(path);
    if (!response) {
      throw new Error(`Unexpected API request: ${path}`);
    }
    await Promise.resolve();
    return response.clone();
  };
  return {
    options: { repository: "owner/repo", number: 40, token: "test-token", request },
    responses,
    calls,
  };
}

describe("GitHub effects", () => {
  it("reads manifests and commits only the generated file on the captured parent", async () => {
    const { options, calls } = fixture();
    const result = await runChangesets(githubServices(options), "publish");
    expect(result.status).toBe("published");
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      {
        path: "/graphql",
        method: "POST",
        body: JSON.stringify({
          query:
            "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
          variables: {
            input: {
              branch: {
                repositoryNameWithOwner: "owner/repo",
                branchName: "dependabot/npm/update",
              },
              expectedHeadOid: head,
              message: { headline: "chore: update dependency changeset for #40" },
              fileChanges: {
                additions: [
                  {
                    path: ".changeset/dependabot-40.md",
                    contents: Buffer.from(
                      '---\n"public": patch\n---\n\nUpdate runtime dependencies in "public".\n\n- Update "execa" from "^10.0.1" to "^10.1.0".\n',
                    ).toString("base64"),
                  },
                ],
                deletions: [],
              },
            },
          },
        }),
      },
    ]);
  });

  it("rejects a changed head before creating Git objects", async () => {
    const { options, responses, calls } = fixture();
    const effects = githubServices(options);
    const source = await effects.load();
    responses.set("/pulls/40", pull(createdCommit));
    await expect(effects.verify(source)).rejects.toThrow(
      "PR head changed. Rerun to generate a changeset for the new head.",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a stale workflow event before reading or writing Git objects", async () => {
    const { options, calls } = fixture();
    const result = await runChangesets(
      githubServices(Object.assign({}, options, { expectedHead: base })),
      "check",
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "PR head no longer matches this workflow run. Run checks on the current head.",
    );
    expect(calls.map((call) => call.path)).toEqual(["/pulls/40"]);
  });

  it("reports GraphQL errors returned with HTTP 200 without retrying the mutation", async () => {
    const { options, responses, calls } = fixture();
    responses.set(
      "/graphql",
      Response.json({
        data: { createCommitOnBranch: null },
        errors: [{ message: "Expected head does not match" }],
      }),
    );
    const result = await runChangesets(githubServices(options), "publish");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("GitHub refused changeset commit: Expected head does not match");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("rejects a non-Dependabot PR before reading its tree", async () => {
    const { options, responses, calls } = fixture();
    responses.set(
      "/pulls/40",
      Response.json({ number: 40, state: "open", user: { login: "someone" } }),
    );
    const result = await runChangesets(githubServices(options), "publish");
    expect(result.status).toBe("failed");
    expect(result.error).toContain('Invalid input: expected \\"dependabot[bot]\\"');
    expect(calls.map((call) => call.path)).toEqual(["/pulls/40"]);
  });

  it("rejects truncated Git trees instead of generating an incomplete changeset", async () => {
    const { options, responses, calls } = fixture();
    responses.set(
      `/git/trees/${headTree}?recursive=1`,
      Response.json({ sha: headTree, truncated: true, tree: [] }),
    );
    const result = await runChangesets(githubServices(options), "publish");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid input: expected false");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
