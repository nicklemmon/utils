import { execa } from "execa";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway local git repository standing in for a real GitHub/GitLab remote. */
export type FixtureRepo = {
  dir: string;
  commit: (message: string, files: Readonly<Record<string, string>>) => Promise<string>;
  cleanup: () => void;
};

/**
 * Create a throwaway local git repository under the OS temp dir, for integration tests to use as a
 * stand-in for a real GitHub/GitLab remote. Git treats a local path the same as any other remote,
 * so tests exercise the real `git` binary end to end.
 *
 * @returns The fixture repo's directory, a `commit` helper, and `cleanup`.
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
 * Create a throwaway bare git repository, seeded with one commit. Unlike {@link createFixtureRepo},
 * this has no working tree to check out or edit directly — real GitHub/GitLab remotes are always
 * bare. Use this instead of {@link createFixtureRepo} for tests that push to the same remote
 * concurrently: a non-bare remote's `receive.denyCurrentBranch=updateInstead` workaround updates
 * its working tree on every push, which two concurrent pushes can race on (`index.lock` contention)
 * in a way a real, bare remote never can.
 *
 * @param seedFiles - Files to commit before the repo is made bare.
 * @returns The bare repo's directory and a `cleanup`.
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
