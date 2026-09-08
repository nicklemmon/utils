import { execa } from "execa";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway local git repository standing in for a real GitHub/GitLab remote. */
export type FixtureRepo = {
  dir: string;
  commit: (message: string, files: Readonly<Record<string, string>>) => Promise<string>;
  cleanup: () => void;
};

/**
 * Create a throwaway local git repository under the OS temp dir.
 *
 * Integration tests use it as a stand-in for a real GitHub or GitLab remote. Git treats a local
 * path like any other remote, so tests exercise the real `git` binary end to end.
 *
 * @returns The fixture repo directory, a `commit` helper, and `cleanup`.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-fixture-"));

  await execa("git", ["init", "--initial-branch=main", dir]);
  await execa("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execa("git", ["-C", dir, "config", "user.name", "Test"]);
  await execa("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  // Real GitHub/GitLab remotes are bare, so pushing to their current branch
  // is never an issue. This fixture is a non-bare repo standing in for one,
  // so it needs this to accept a push the same way a bare remote would.
  await execa("git", ["-C", dir, "config", "receive.denyCurrentBranch", "updateInstead"]);

  async function commit(message: string, files: Readonly<Record<string, string>>): Promise<string> {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(dir, relativePath);

      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }

    await execa("git", ["-C", dir, "add", "-A"]);
    await execa("git", ["-C", dir, "commit", "-m", message]);

    const { stdout } = await execa("git", ["-C", dir, "rev-parse", "HEAD"]);

    return stdout;
  }

  function cleanup(): void {
    rmSync(dir, { recursive: true, force: true });
  }

  return { dir, commit, cleanup };
}

/** A throwaway bare git repository, for tests that need concurrent pushes. */
export type BareFixtureRepo = {
  dir: string;
  cleanup: () => void;
};

/**
 * Create a throwaway bare git repository, seeded with one commit.
 *
 * Unlike {@link createFixtureRepo}, this has no working tree. Real GitHub and GitLab remotes are
 * bare. Use this for concurrent-push tests: a non-bare remote with
 * `receive.denyCurrentBranch=updateInstead` updates its working tree on every push, and two
 * concurrent pushes can race on `index.lock` in a way a real bare remote never can.
 *
 * @param seedFiles - Files to commit before the repo is made bare.
 * @returns The bare repo directory and a `cleanup`.
 */
export async function createBareFixtureRepo(
  seedFiles: Readonly<Record<string, string>>,
): Promise<BareFixtureRepo> {
  const staging = await createFixtureRepo();

  await staging.commit("Seed commit", seedFiles);

  const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-bare-"));

  await execa("git", ["clone", "--bare", "--quiet", staging.dir, dir]);
  staging.cleanup();

  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a throwaway bare git repository with zero commits and no resolvable `HEAD`.
 *
 * Real GitHub and GitLab remotes adopt the first pushed branch as their default. Plain `git init
 * --bare` does not. A `post-receive` hook here copies that platform behavior so the fixture matches
 * an empty remote.
 *
 * The hook must be `post-receive`, not `pre-receive`. Git quarantines incoming objects during
 * `pre-receive` and rejects ref updates from that hook. On newer git (CI runners), that rejection
 * fails `git symbolic-ref` and the hook exits non-zero, so the whole push is declined.
 *
 * @returns The bare repo directory and a `cleanup`.
 */
export async function createEmptyBareFixtureRepo(): Promise<BareFixtureRepo> {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-gl-bare-"));

  await execa("git", ["init", "--bare", "--quiet", dir]);

  const hookPath = path.join(dir, "hooks", "post-receive");

  writeFileSync(
    hookPath,
    [
      "#!/bin/sh",
      "# Emulate GitHub/GitLab: the first branch ever pushed becomes the default.",
      "# post-receive (not pre-receive): git rejects ref updates during pre-receive",
      "# quarantine, which fails this hook and declines the push on newer git.",
      'created=""',
      "while read -r old_sha new_sha ref_name; do",
      '  case "$old_sha" in',
      "    0000000000000000000000000000000000000000)",
      '      case "$ref_name" in',
      '        refs/heads/*) created="$ref_name" ;;',
      "      esac",
      "      ;;",
      "  esac",
      "done",
      'if [ -n "$created" ]; then',
      "  count=0",
      '  for _ in $(git for-each-ref --format="%(refname)" refs/heads); do',
      "    count=$((count + 1))",
      "  done",
      '  if [ "$count" -eq 1 ]; then',
      '    git symbolic-ref HEAD "$created"',
      "  fi",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(hookPath, 0o755);

  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
