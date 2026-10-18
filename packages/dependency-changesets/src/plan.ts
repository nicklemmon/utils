import picomatch from "picomatch";
import { z } from "zod";

const manifestSchema = z.object({
  name: z.string().min(1),
  private: z.boolean().default(false),
  dependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});

/** Package manifests read at the base and head commits. */
export type PackageChange = Readonly<{
  path: string;
  before: string;
  after: string;
}>;

/** Data needed to generate the changeset owned by one PR. */
export type ChangesetSource = Readonly<{
  number: number;
  head: string;
  branch: string;
  ignored: readonly string[];
  packages: readonly PackageChange[];
  existing: string | undefined;
}>;

/** One changeset file to create, update, remove, or leave unchanged. */
export type ChangesetPlan = Readonly<{
  path: string;
  content: string | null;
  changed: boolean;
}>;

/**
 * Build a patch changeset from public package runtime dependency changes.
 *
 * @param source - Manifests from the merge base and PR head. The file name belongs to this PR.
 * @returns A file update, deletion, or no change. No files are written.
 */
export function planChangeset(source: ChangesetSource): ChangesetPlan {
  const releases: string[] = [];
  const summaries: string[] = [];
  const ignored = source.ignored.map((pattern) => picomatch(pattern, undefined, true));

  for (const change of source.packages.toSorted((a, b) => a.path.localeCompare(b.path))) {
    const before = manifestSchema.parse(JSON.parse(change.before));
    const after = manifestSchema.parse(JSON.parse(change.after));
    if (before.name !== after.name || before.private !== after.private) {
      throw new Error(`Package identity changed: ${change.path}`);
    }
    let isIgnored = false;
    for (const matches of ignored) {
      isIgnored = matches.state.negated
        ? isIgnored && matches(after.name)
        : isIgnored || matches(after.name);
    }
    if (after.private || isIgnored) {
      continue;
    }
    const peers = new Set([
      ...Object.keys(before.peerDependencies),
      ...Object.keys(after.peerDependencies),
    ]);
    if ([...peers].some((name) => before.peerDependencies[name] !== after.peerDependencies[name])) {
      throw new Error(`Peer dependency changes need manual review: ${change.path}`);
    }
    const dependencies = [
      ...new Set([...Object.keys(before.dependencies), ...Object.keys(after.dependencies)]),
    ].toSorted();
    const updates: string[] = [];
    for (const name of dependencies) {
      const oldRange = before.dependencies[name];
      const newRange = after.dependencies[name];
      if (oldRange === newRange) {
        continue;
      }
      if (oldRange === undefined || newRange === undefined) {
        throw new Error(`Dependency additions or removals need manual review: ${change.path}`);
      }
      updates.push(
        `- Update ${JSON.stringify(name)} from ${JSON.stringify(oldRange)} to ${JSON.stringify(newRange)}.`,
      );
    }
    if (updates.length > 0) {
      releases.push(`${JSON.stringify(after.name)}: patch`);
      summaries.push(
        `Update runtime dependencies in ${JSON.stringify(after.name)}.\n\n${updates.join("\n")}`,
      );
    }
  }

  const content =
    releases.length === 0
      ? null
      : `---\n${releases.join("\n")}\n---\n\n${summaries.join("\n\n")}\n`;
  return {
    path: `.changeset/dependabot-${source.number}.md`,
    content,
    changed: content !== (source.existing ?? null),
  };
}
